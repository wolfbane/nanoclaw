import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, SendMessageFn } from './types.js';

export interface IpcDeps {
  sendMessage: SendMessageFn;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

// Ack dirs created lazily on first write per group; recursive mkdir is
// idempotent but a syscall per message otherwise.
const knownAckDirs = new Set<string>();

export function writeIpcAck(
  ipcBaseDir: string,
  sourceGroup: string,
  requestId: string,
  status: 'success' | 'error',
  error?: string,
): void {
  try {
    const acksDir = path.join(ipcBaseDir, sourceGroup, 'acks');
    if (!knownAckDirs.has(acksDir)) {
      fs.mkdirSync(acksDir, { recursive: true });
      knownAckDirs.add(acksDir);
    }
    const ackPath = path.join(acksDir, `${requestId}.json`);
    const tmpPath = `${ackPath}.tmp`;
    const payload: {
      requestId: string;
      status: 'success' | 'error';
      error?: string;
      completedAt: string;
    } = {
      requestId,
      status,
      completedAt: new Date().toISOString(),
    };
    if (error) payload.error = error;
    // Atomic write — agent polls and must not read a partial file.
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    fs.renameSync(tmpPath, ackPath);
  } catch (err) {
    logger.error(
      { err, sourceGroup, requestId },
      'Failed to write IPC ack file',
    );
  }
}

/** Exported so tests can drive the message path without the polling loop. */
export async function processIpcMessageFile(
  ipcBaseDir: string,
  messagesDir: string,
  file: string,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<void> {
  const filePath = path.join(messagesDir, file);
  let parsedData: {
    type?: string;
    chatJid?: string;
    text?: string;
    sender?: string;
    requestId?: string;
  } | null = null;
  try {
    parsedData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const data = parsedData!;
    const requestId = deriveRequestId(data, file);
    if (data.type === 'message' && data.chatJid && data.text) {
      // Authorization: verify this group can send to this chatJid
      const targetGroup = registeredGroups[data.chatJid];
      if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
        const sendStart = Date.now();
        try {
          await deps.sendMessage(data.chatJid, data.text, 'mcp');
          logger.info(
            {
              chatJid: data.chatJid,
              sourceGroup,
              tool: 'mcp.send_message',
              length: data.text.length,
              sender: data.sender,
              durationMs: Date.now() - sendStart,
            },
            'MCP send_message dispatched',
          );
          writeIpcAck(ipcBaseDir, sourceGroup, requestId, 'success');
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(
            {
              chatJid: data.chatJid,
              sourceGroup,
              tool: 'mcp.send_message',
              length: data.text.length,
              sender: data.sender,
              durationMs: Date.now() - sendStart,
              err: errMsg,
            },
            'MCP send_message dispatch failed',
          );
          writeIpcAck(ipcBaseDir, sourceGroup, requestId, 'error', errMsg);
          // Don't rethrow — the ack is the delivery contract; rethrow would
          // trigger the outer catch and produce a duplicate error ack.
        }
      } else {
        logger.warn(
          { chatJid: data.chatJid, sourceGroup },
          'Unauthorized IPC message attempt blocked',
        );
        writeIpcAck(
          ipcBaseDir,
          sourceGroup,
          requestId,
          'error',
          'Unauthorized: this group is not permitted to send to that chat.',
        );
      }
    }
    fs.unlinkSync(filePath);
  } catch (err) {
    logger.error(
      { file, sourceGroup, err },
      'Error processing IPC message',
    );
    // Best-effort ack so the agent doesn't hang on a malformed request.
    try {
      writeIpcAck(
        ipcBaseDir,
        sourceGroup,
        deriveRequestId(parsedData, file),
        'error',
        err instanceof Error ? err.message : String(err),
      );
    } catch {
      /* already logged above */
    }
    const errorDir = path.join(ipcBaseDir, 'errors');
    fs.mkdirSync(errorDir, { recursive: true });
    fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
  }
}

function deriveRequestId(
  data: { requestId?: string } | null,
  fileName: string,
): string {
  return data?.requestId || fileName.replace(/\.json$/, '');
}

function readJsonFiles(
  dir: string,
  sourceGroup: string,
  kind: 'messages' | 'tasks',
): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    logger.error(
      { err, sourceGroup, kind },
      'Error reading IPC directory',
    );
    return [];
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs
        .readdirSync(ipcBaseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'errors')
        .map((e) => e.name);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      for (const file of readJsonFiles(messagesDir, sourceGroup, 'messages')) {
        await processIpcMessageFile(
          ipcBaseDir,
          messagesDir,
          file,
          sourceGroup,
          isMain,
          registeredGroups,
          deps,
        );
      }

      for (const file of readJsonFiles(tasksDir, sourceGroup, 'tasks')) {
        const filePath = path.join(tasksDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          await processTaskIpc(data, sourceGroup, isMain, deps);
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error(
            { file, sourceGroup, err },
            'Error processing IPC task',
          );
          const errorDir = path.join(ipcBaseDir, 'errors');
          fs.mkdirSync(errorDir, { recursive: true });
          fs.renameSync(
            filePath,
            path.join(errorDir, `${sourceGroup}-${file}`),
          );
        }
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
