---
name: searxng-search
description: Search the web using a self-hosted SearXNG instance. Use for research, finding URLs, checking current information.
---

# Web Search with SearXNG

A self-hosted SearXNG instance is available. From inside the container, reach it at `host.docker.internal:8888` (the host machine's localhost).

## Basic search

```bash
curl -s "http://host.docker.internal:8888/search?q=YOUR+QUERY&format=json" | \
  node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); r.results.slice(0,5).forEach(x=>console.log(x.title+'\n'+x.url+'\n'+x.content+'\n'))"
```

## Search with category

```bash
# categories: general, news, images, science, files, it
curl -s "http://host.docker.internal:8888/search?q=YOUR+QUERY&categories=news&format=json&pageno=1"
```

## Tips
- Default result count: 5 (use `&pageno=2` for more)
- Timeout: 10 seconds
- If SearXNG is not running, the request will fail — check with `curl -s http://host.docker.internal:8888/` first
