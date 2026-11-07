#!/bin/bash
# Copies the MCP tool definitions from the Mac app (MCP.swift) into src/tools.json, so agents read
# the same words on both. Run after changing a tool description in Sources/Curator/MCP.swift.
set -euo pipefail
cd "$(dirname "$0")/../.."
swift build -c release --product Curator >/dev/null
BIN="$(swift build -c release --show-bin-path)/Curator"
( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; sleep 2 ) | "$BIN" mcp \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\n")[0]).result.tools;require("fs").writeFileSync("windows/src/tools.json",JSON.stringify(t,null,2)+"\n");console.log("Wrote windows/src/tools.json:",t.map(x=>x.name).join(", "))})'
