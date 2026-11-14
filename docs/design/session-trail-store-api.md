# Session Trail: Store, API และการรวมกับ Hook

> ส่วนที่ 2–3 ของ Session Trail design · สถานะ: **อนุมัติแล้ว (2026-11-14) ดู §12** · ไม่มีโค้ดในเอกสารนี้
> ส่วนที่ 1 (Transcript Indexer) อยู่อีก session: เอกสารนี้กำหนดแค่ **interface ที่ต้องการจาก indexer** (§7)

อ้างอิงโค้ดปัจจุบันทั้งหมดจาก `bridge/server.mjs` และ `web/app.js`, `web/scene.js` ที่ commit `0c6b598`

---

## 0. สรุป 1 นาที

1. **แยกข้อมูลเป็น 3 ชั้น**: `index.json` (catalog ทุก session) · `trails/<id>.jsonl` (timeline แบบ append-only) · `state.json` (สถานะ live เท่านั้น ไม่มี trail แล้ว)
2. **แต่ละ trail `kind` มีแหล่งจริงที่เดียว** (hook, bridge หรือ transcript) จึงไม่ต้องมี dedupe ข้ามแหล่ง มีข้อยกเว้นเดียวคือ indexer ต้องข้ามข้อความที่ hook ฉีดเข้า transcript
3. **เพิ่มมิติ `presence`** (`live` / `idle` / `ended` / `history`) แยกจาก `status` เดิม (`working`, `waiting` ฯลฯ) UI เดิมจึงไม่พัง
4. **API ใหม่ใช้ `POST /api/...`** ไม่ใช่ `GET` ตามที่ร่างไว้ก่อนหน้า เพราะ guard ของ bridge ตอนนี้ (token header + Origin) ใช้กับ POST เท่านั้น และ `GET` ทุก path จะตกไปที่ static file server (`server.mjs:872-875`)
5. **`session` SSE จะเบาลงมาก**: ทุกวันนี้ `publicSession` ส่ง `trail` ทั้ง 200 รายการไปกับทุก `touch()` แบบใหม่จะไม่ส่ง trail ใน message นี้แล้ว

---

## 1. สิ่งที่โค้ดทำอยู่วันนี้ (จุดตั้งต้น)

| เรื่อง | ตอนนี้ | ปัญหา |
|---|---|---|
| trail | `s.trail[]` ในหน่วยความจำ, `TRAIL_MAX = 200` (`:27`), `addTrail` (`:197`) | ประวัติหาย, ไม่มี tool call ราย call (มีแค่ใน feed) |
| เก็บถาวร | `state.json` ก้อนเดียว ทุก 5 วินาที (`:74-80`), เขียนแบบ `fs.writeFile` ทับตรงๆ | ไฟล์โตตาม trail × session, เขียนพังกลางทางได้ |
| อายุ | `ENDED_TTL_MS = 24h` แล้วลบทิ้ง (`:26`, `:887-891`) | session จบแล้ว 1 วันหายจากทุกที่ |
| restart | session ที่ไม่ใช่ `ended` กลายเป็น `stale` (`:62`) | ไม่รู้ว่าระหว่าง bridge ดับเกิดอะไร |
| SSE | `touch()` → `broadcast({type:'session', session: publicSession(s)})` (`:252-255`) | ส่ง trail 200 รายการซ้ำทุก event |
| โต๊ะ | `scene.update` หาโต๊ะว่างด้วย `seatOrder.find`, เต็มแล้ว `continue` เงียบๆ (`scene.js:2110-2111`) | session ที่ 43 หายไปจากฉากโดยไม่มีอะไรบอก |
| ความปลอดภัย | Host allowlist (`:727`), `/api/*` POST + `x-office-token` + Origin (`:777-780`), `/events` token ใน query (`:756`) | คงไว้ทั้งหมด |

---

## 2. Data model

### 2.1 โครงไฟล์ใน `~/.agent-office/` (`DATA_DIR`)

```
~/.agent-office/
  token                 (เดิม)
  bridge.lock           ใหม่: pid ของ bridge ที่ถือ DATA_DIR อยู่
  index.json            ใหม่: catalog ทุก session (เขียนแบบ atomic)
  state.json            เดิม แต่ v2: เฉพาะ live state ไม่มี trail
  state.v1.json.bak     สำรองตอน migrate ครั้งแรก
  trails/
    <sessionId>.jsonl   ใหม่: append-only, 1 บรรทัด = 1 entry หรือ 1 cursor
```

### 2.2 `index.json` (session record)

```json
{
  "v": 1,
  "sessions": {
    "0ecc2fc3-8d6c-4af9-98e4-afc0e984ab22": {
      "id": "0ecc2fc3-8d6c-4af9-98e4-afc0e984ab22",
      "title": "Claude agent office repository",
      "titleSrc": "custom-title",
      "project": "claude-agent-office",
      "cwd": "E:\\My Second Brain\\Project Code\\claude-agent-office",
      "gitBranch": "main",
      "model": "claude-opus-5-5",
      "firstAt": 1731050000000,
      "lastAt": 1731571200000,
      "endedAt": null,
      "endReason": null,
      "waiting": false,
      "forkedFrom": null,
      "lastPrompt": "Pull Commit ล่าสุดมาให้หน่อยค่ะ",
      "counts": { "prompts": 33, "tools": 410, "errors": 3 },
      "transcript": "C:\\Users\\…\\0ecc2fc3-….jsonl",
      "trailBuilt": true,
      "scan": { "size": 482113, "mtimeMs": 1731571209000, "headHash": "9f2c…", "parserVersion": 1 }
    }
  }
}
```

**แต่ละ field มาจากไหน** (เจ้าของต่อ field ชัดเจน จะได้ไม่เขียนทับกัน):

| field | เจ้าของ | หมายเหตุ |
|---|---|---|
| `title`, `titleSrc` | indexer | `titleSrc` มีค่าได้เป็น `custom-title` (ชื่อที่ตั้งเอง ใช้ตัวล่าสุด) · `ai-title` (ชื่อที่ AI ตั้งให้) · `first-prompt` (prompt แรกที่ clip แล้ว ใช้เมื่อไม่มีสองแบบแรก) |
| `cwd`, `project`, `gitBranch`, `model`, `firstAt`, `transcript` | indexer | hook `SessionStart` เติมได้ถ้า indexer ยังไม่เห็นไฟล์ |
| `forkedFrom` | indexer | session id ต้นทางถ้าเป็น session ที่ fork มา ไม่ใช่ fork ก็เป็น `null` |
| `lastPrompt` | indexer | prompt ล่าสุดที่ผ่าน `clip(…, 80)` แล้ว ใช้เป็นบรรทัดรองในรายการ History |
| `lastAt` | `max(indexer.lastAt, lastHookAt)` | ใช้เรียง History |
| `endedAt`, `endReason` | hook `SessionEnd` เท่านั้น | transcript ไม่มีเหตุการณ์จบ |
| `waiting` | store (จาก hook/bridge) | `true` เมื่อ session รอคำตอบอยู่ (มี approval ค้าง หรือ `status === 'waiting'`) UI ขอ field นี้ไว้ทำจุดเตือนในรายการ History |
| `counts` | store นับตอน append | ไม่ต้อง parse ใหม่ |
| `trailBuilt` | store | `false` = session ย้อนหลังที่ยังไม่เคยเปิดดู (lazy build) |
| `scan` | indexer | `{size, mtimeMs, headHash, parserVersion}` เป็น cache สำหรับทางลัดตอน startup ถ้าทั้ง 4 ค่ายังตรงกับไฟล์ ไม่ต้องสแกนไฟล์นั้นใหม่ ข้อมูลนี้อยู่ใน `index.json` ที่เดียว **ไม่มีไฟล์ `transcripts.json` แยก** |

`transcript` (path เต็ม) และ `scan` **ไม่ส่งออก API**: UI ไม่ต้องใช้ และไม่ควรโชว์ path ใน home folder โดยไม่จำเป็น

ขนาด: ~400 B/record × 123 session ≈ 50 KB โหลดทั้งก้อนเข้าหน่วยความจำได้สบาย

### 2.3 `trails/<id>.jsonl` (trail entry)

```json
{"id":"t:toolu_01AbC","t":1731571200123,"kind":"tool","src":"transcript","text":"Edit · scene.js","tool":"Edit"}
{"id":"t:toolu_01AbC:err","t":1731571201456,"kind":"error","src":"transcript","text":"Edit failed: old_string not found"}
{"id":"b:lx9k2a-7","t":1731571210000,"kind":"permission","src":"bridge","text":"Allowed: Bash"}
{"cursor":{"off":482113,"size":482113,"mtime":1731571209000}}
```

| field | type | กติกา |
|---|---|---|
| `id` | string | **stable** และมี prefix ตามแหล่ง: `t:` = transcript, `h:` = hook, `b:` = bridge, `l:` = legacy (ย้ายมาจาก v1) |
| `t` | ms epoch | เวลาจริงของเหตุการณ์ (transcript ใช้ `timestamp` ของบรรทัด ไม่ใช่เวลาที่ ingest) |
| `kind` | enum | ชื่อเดิมทั้งหมด (`session` `env` `mode` `skill` `prompt` `background` `error` `notify` `subagent` `permission` `dispatch` `git` `other`) **+ `tool` ใหม่** |
| `src` | enum | `transcript` · `hook` · `bridge` · `legacy` |
| `text` | string ≤ 200 | ต้องผ่าน `clip()` → `redact()` (`:91-101`) เสมอ ห้ามมีเนื้อหาดิบ |
| `tool`, `agent`, `bg` | optional | ชื่อ tool, subagent type (บรรทัด sidechain), background flag |

**ที่มาของ stable id**

- `t:<uuid>` สำหรับ prompt (uuid ของบรรทัด user ใน transcript)
- `t:<tool_use_id>` สำหรับการเรียก tool, `t:<tool_use_id>:err` ถ้า tool_result เป็น error
  - **ไม่ใช้วิธี patch entry เดิม** (เช่น อัปเดต `ok` ทีหลัง) เพราะการ fold ข้ามหน้าตอนแบ่ง page จะยุ่งเกินจำเป็น tool ที่สำเร็จจึงมีแค่ entry เดียว ส่วน tool ที่ล้มเหลวมีสองอัน
- `h:` / `b:` ใช้ `<ts36>-<counter>` ที่ bridge ออกให้เอง เพราะ hook ไม่มี id ในตัว และ Claude Code ไม่ retry HTTP hook จึงไม่มีโอกาสซ้ำ

**บรรทัด `cursor`** คือตำแหน่งที่ indexer อ่าน transcript ถึงแล้ว ถูกเขียน **ใน `write` เดียวกับ batch ของ entry** (ดู §2.4) ฝั่งอ่านข้ามบรรทัดที่ไม่มี `id`
- ค่า `cursor` เป็น **opaque** สำหรับ store: indexer เป็นคนกำหนดหน้าตา และใส่ `ctx` ของ parser ของตัวเองไว้ข้างในได้ (เช่น state ที่ต้องใช้ต่อจากบรรทัดก่อนหน้า) ส่วน store แค่เก็บและคืนให้ทั้งก้อน
- ตัวอย่าง `{"off","size","mtime"}` ข้างบนใช้แสดงแนวคิดเท่านั้น

ขนาดโดยประมาณ: ~180 B/entry · session ใหญ่ 2,000 tool call ≈ 400 KB · ทั้งเครื่องอยู่ในหลักสิบ MB

### 2.4 Idempotent append และการเขียนบน Windows

**ปัญหาที่ต้องกัน**: crash ระหว่าง "append entry" กับ "บันทึก offset" → รอบหน้าอ่าน transcript ซ้ำ → entry ซ้ำ

**วิธี: เก็บ offset ไว้ในไฟล์ trail เดียวกัน**

1. indexer ส่ง `(entries[], cursor)` มาเป็นก้อนเดียว
2. store รวมเป็น buffer เดียว `entries…\n{"cursor":…}\n` แล้ว **`fs.appendFile` ครั้งเดียว** (เปิดแบบ `O_APPEND`)
3. ตอนเปิดไฟล์ (startup หรือ lazy):
   - ถ้าบรรทัดสุดท้ายไม่จบด้วย `\n` (torn write) → `ftruncate` ไปที่ `\n` ตัวสุดท้าย
   - หา `cursor` ตัวล่าสุดโดย **อ่านย้อนจากท้ายไฟล์ทีละ chunk 64 KB จนกว่าจะเจอ cursor หรือถึงต้นไฟล์** (ระวังบรรทัดที่คร่อมรอยต่อ chunk ด้วย) → คืนให้ indexer เป็นจุดเริ่มอ่าน ถ้าถึงต้นไฟล์แล้วไม่เจอ ก็คืน `null` (อ่าน transcript ตั้งแต่ต้น)
   - อ่านแค่ chunk สุดท้ายไม่พอ เพราะ entry จาก hook/bridge อาจสะสมต่อจาก cursor ตัวสุดท้ายได้เยอะ เช่น ช่วงที่ indexer อยู่ใน degraded mode (§3.2 ข้อ 4) (D12)
4. ผล: entry กับ cursor อยู่หรือหายไปด้วยกันเสมอ ไม่ต้องมีไฟล์ offset แยก และไม่ต้องจำ set ของ id
5. กันชั้นที่สอง (เผื่อ indexer ส่งซ้ำเอง): store เก็บ `Set` ของ id ล่าสุด 512 ตัวต่อ session ที่เปิดอยู่ ซ้ำ → ทิ้ง

**การ serialize**: เขียนต่อ session ผ่าน promise chain ตัวเดียว (`writeQueue[id] = writeQueue[id].then(...)`) ป้องกัน append สองก้อนสลับกัน

**ข้อยกเว้นเดียวที่ไฟล์ไม่ได้เป็น append-only: reset** (D11) เกิดเมื่อ indexer รายงานว่า transcript ถูก truncate หรือแทนที่ทั้งไฟล์
1. เข้าคิวใน `writeQueue[id]` ตัวเดียวกัน (จะไม่มี append ใดแทรกเข้ามาระหว่างนั้น)
2. อ่าน `trails/<id>.jsonl` แล้ว **เก็บเฉพาะ entry ที่ `src` เป็น `hook` / `bridge` / `legacy`** ทิ้ง entry ที่ `src: "transcript"` และบรรทัด `cursor` ทุกบรรทัด
3. เขียนผลลงไฟล์แบบ atomic (`*.tmp` → `rename` แล้ว retry `EPERM`/`EBUSY` แบบเดียวกับ `index.json` ข้างล่าง)
4. ล้าง `Set` ของ id ล่าสุดของ session นั้น, ลบ `counts.prompts/tools` ฝั่ง transcript แล้ว `counts.errors` คำนวณใหม่จาก entry ที่เหลือ
5. resolve Promise ที่ `on('reset')` คืนไป **หลังจาก rename เสร็จ** และก่อนที่ indexer จะยิง `entries` ชุดแรกของการ rebuild
6. ส่ง SSE `trail-reset {sessionId}` ให้ client โหลดหน้าแรกใหม่

**`index.json` และ `state.json` เขียนแบบ atomic**: เขียน `*.tmp` → `fs.renameSync(tmp, target)`
- บน Windows `rename` ทับไฟล์เดิมได้ (ใช้ `MoveFileEx` + `REPLACE_EXISTING`) แต่จะ **ล้มด้วย `EPERM`/`EBUSY`** ได้ ถ้า antivirus, Windows Search หรือ OneDrive ถือ handle ไว้ → retry 3 ครั้ง (50, 150, 400 ms) ถ้ายังไม่ได้ ให้คงไฟล์ `.tmp` ไว้และลองใหม่รอบ save ถัดไป (dirty flag ยังเป็น true)
- ตอนโหลด ถ้าไฟล์หลัก parse ไม่ได้แต่มี `.tmp` ที่ parse ได้ → ใช้ `.tmp`
- debounce: `index.json` เขียนไม่เกินทุก 2 วินาที, `state.json` ทุก 5 วินาทีเหมือนเดิม

**Single writer**: ทุกวันนี้ port กันไม่ให้รันสองตัวได้ก็จริง แต่ถ้ารันสองตัวด้วย `AGENT_OFFICE_PORT` ต่างกันและ `DATA_DIR` เดียวกัน ทั้งคู่จะเขียนไฟล์เดียวกัน → ตอนเริ่มให้ `fs.openSync('bridge.lock', 'wx')` แล้วเขียน pid ลงไป
- ถ้ามีไฟล์อยู่แล้ว: เช็กว่า pid นั้นยังมีชีวิตไหมด้วย `process.kill(pid, 0)` ถ้าตายแล้ว → ยึด lock ต่อได้ ถ้ายังอยู่ → exit พร้อมข้อความ
- ลบ lock ใน `shutdown()` (`:905`)
- ต้อง **ได้ lock ก่อน** `loadState()` (ตอนนี้ `loadState` อยู่ที่ `:893` ก่อน `listen`)

---

## 3. แบ่งแหล่งข้อมูลจริง (source-of-truth split)

### 3.1 จัดทุก `addTrail` ที่มีอยู่

| บรรทัด | trail ตอนนี้ | แหล่งใหม่ | เหตุผล |
|---|---|---|---|
| `:159` | `Session joined · cwd` | **ตัดทิ้ง** | ซ้ำกับ `SessionStart` และไม่ใช่เหตุการณ์จริง (เป็นแค่ตอนที่ bridge เห็น session ครั้งแรก) |
| `:164` | `Effort →` | hook | transcript มี effort แต่อยู่ในบรรทัด internal (`api-request`) ที่ไม่ควรพึ่ง |
| `:168` | `Permission mode →` | hook | มีในทุก event อยู่แล้ว |
| `:182` | `Using/Ran skill` | **transcript** | `Skill` tool_use และ prompt ที่ขึ้นต้นด้วย `/` อยู่ใน transcript ครบ (state `s.skill` ที่ใช้ให้ avatar เดินไปห้องสมุด ยังมาจาก hook เหมือนเดิม) |
| `:280` | `Model →` (statusline) | hook | |
| `:371` | `Session startup/resume/clear` | hook | transcript ไม่บอก `source` |
| `:381` | `Session ended` | hook | transcript ไม่มีเหตุการณ์จบ |
| `:389` | `Prompt:` | **transcript** | |
| `:410` | `Background Bash/Agent` | **transcript** | tool_use ที่มี `run_in_background` → entry `tool` พร้อม `bg: true` (state `s.background` ยังมาจาก hook) |
| `:413` | `git checkout / cd` | **transcript** | เป็นแค่ Bash call ตัวหนึ่ง จะเห็นเป็น entry `tool` อยู่แล้ว |
| `:427` | `X failed` | **transcript** | tool_result ที่ `is_error` → `t:<id>:err` |
| `:441` | Notification | hook | ไม่มีใน transcript |
| `:452` | `API error` (StopFailure) | hook | ไม่แน่ใจว่า transcript บันทึก API error ไว้ทุกแบบหรือเปล่า → ให้ hook ถือไว้ |
| `:458`, `:468` | Subagent started/finished | **transcript** | `Agent`/`Task` tool_use และ tool_result (desk เล็กของ subagent ยังมาจาก hook) |
| `:487` | `cwd →` | hook | |
| `:493`, `:498` | compaction | hook | `PreCompact` มี `trigger` และ indexer ต้องข้ามบรรทัด compaction ของ transcript |
| `:503` | `Model →` (switch) | hook | |
| `:507` | default `other` | hook | |
| `:516`, `:572` | permission asked/settled | **bridge** | bridge เป็นคนตัดสินใจเอง |
| `:616`, `:666`, `:672` | dispatch | **bridge** | |
| `:807`, `:824`, `:831` | plugin/git จาก dashboard | **bridge** | |
| `:853`, `:865` | standby, queue cleared | **bridge** | |
| ใหม่ | การเรียก tool ทุกครั้ง | **transcript** | นี่คือ timeline ที่ขอ (ตอนนี้มีแค่ใน feed ชั่วคราว `:415`) |

สรุป kind ตามแหล่ง:
- **transcript**: `prompt` · `tool` · `skill` · `subagent` · `error` (ฝั่ง tool)
- **hook**: `session` · `env` · `mode` · `notify` · `error` (ฝั่ง API) · `other`
- **bridge**: `permission` · `dispatch` · `git`

`error` มีสองแหล่งแต่ไม่ซ้ำกัน: id `t:…:err` มาจาก tool ส่วน `h:…` มาจาก `StopFailure`

> **ข้อจำกัดที่ยอมรับแล้ว:** session ย้อนหลัง (ที่ hook ไม่เคยเห็น เช่น เกิดก่อนติดตั้ง hook หรือตอน bridge ปิดอยู่) จะ **ไม่มี** trail ฝั่ง hook เลย คือไม่มี `env` (cwd/effort/model) · `mode` · compaction · `notify` · `session` start/end มีแค่สิ่งที่ transcript ให้ได้ (`prompt` `tool` `skill` `subagent` `error`) เพราะ hook ไม่เคยเห็น session เหล่านั้น

**ส่วนที่ไม่เปลี่ยน**: `pushFeed` และ field สถานะ live ทุกตัว (`status`, `activity`, `skill`, `touched`, `mcpUsed`, `background`, `subagents`, `tasks`, `todos`) ยังมาจาก hook เหมือนเดิม เปลี่ยนเฉพาะ **trail**

### 3.2 Dedupe rules

1. **ข้ามแหล่ง: ไม่ต้องทำ** เพราะ kind ถูกแบ่งให้แหล่งเดียวแล้ว
2. **ข้อยกเว้นที่ indexer ต้องจัดการ**: ข้อความที่ hook ฉีดเข้า transcript ต้องไม่กลายเป็น `prompt`
   - งานที่ dispatch ผ่าน `Stop` → `additionalContext` (`:592-594`) ไปโผล่ใน transcript (มี key `hookAdditionalContext` จริง ตามที่ session แม่สำรวจไว้)
   - บรรทัด `isMeta`, `attachment`, ข้อความ `<system-reminder>`, `<command-…>`
   - ถ้า indexer ไม่ข้าม เราจะเห็น "Delivered task" (bridge) และ "Prompt: New task assigned from Minju's desk…" (transcript) ซ้ำกัน
3. **ซ้ำในแหล่งเดียว**: กันด้วย stable id + cursor-in-file (§2.4)
4. **Degraded mode** (กันกรณี format ของ transcript เปลี่ยน): ถ้า indexer รายงาน `healthy: false` (parse error เกินเกณฑ์) หรือตั้ง `AGENT_OFFICE_TRANSCRIPTS=0` → hook handler กลับไปเขียน kind ฝั่ง transcript เอง (`src: "hook"`) เหมือนวันนี้
   - เป็นสวิตช์ระดับทั้ง bridge ไม่ใช่ต่อ entry ดังนั้นยังไม่มีทางเกิดของซ้ำ
   - trail ที่ได้จะไม่มี history ย้อนหลัง แต่ live ยังใช้ได้ครบ

### 3.3 `state.json` v2 หดลงเหลือเท่าไหร่

```json
{
  "v": 2,
  "sessions": [ /* เฉพาะ presence ≠ history; ไม่มี field trail */ ],
  "feed": [ /* เดิม, FEED_MAX 300 */ ],
  "limits": { }
}
```

- ตัด `trail` ออกจากทุก session (เดิม 200 × ~150 B ≈ 30 KB ต่อ session)
- ตัด session ที่ presence เป็น `history` ออก (ข้อมูลถาวรอยู่ใน `index.json` แล้ว)
- ผลรวม: จากหลักร้อย KB–MB เหลือหลักสิบ KB

---

## 4. Session state machine

### 4.1 สองมิติ (ไม่แตะ `status` เดิม)

- **`status`** (เดิม): `idle` `thinking` `working` `waiting` `standby` `compacting` `error` `ended` `stale` ใช้กับสีโต๊ะ, animation และ `isActive` ใน `app.js:56`
- **`presence`** (ใหม่): ตอบคำถาม "ควรมีโต๊ะไหม และอยู่ส่วนไหนของ History"

### 4.2 Presence transitions

```
            ไม่มี hook 10 นาที และไม่มี pin            เงียบเกิน 60 นาที
 ┌──────┐ ─────────────────────────────▶ ┌──────┐ ──────────────────▶ ┌─────────┐
 │ live │                                │ idle │                     │ history │
 └──────┘ ◀───────────────────────────── └──────┘                     └─────────┘
   │  ▲       hook event / transcript append                             │    ▲
   │  └──────────────────────────────────────────────────────────────────┘    │
   │           hook event (เช่น resume ด้วย session id เดิม)                  │
   │ SessionEnd                                                              │
   ▼                                                                         │
 ┌───────┐ ──────────────── ครบ ENDED_DESK_MS (15 นาที) ─────────────────────┘
 │ ended │   (ระหว่างนี้ถ้ามี hook event ไม่ใช่ SessionEnd → กลับเป็น live)
 └───────┘
```

ค่าที่ใช้ (env override ได้แบบเดียวกับ `AGENT_OFFICE_*` เดิม):

| ค่าคงที่ | ค่าที่เสนอ | ความหมาย |
|---|---|---|
| `LIVE_HOOK_MS` | 10 นาที | live ต่อได้ถ้ามี hook ในช่วงนี้ |
| `LIVE_TRANSCRIPT_MS` | 2 นาที | transcript โตแต่ไม่มี hook (เช่น session เปิดก่อนติดตั้ง hook) ยังนับว่า live |
| `IDLE_WINDOW_MS` | 60 นาที | หลังจากนี้ปล่อยโต๊ะ ย้ายเข้า History |
| `ENDED_DESK_MS` | 15 นาที | session ที่จบแล้วอยู่ที่โต๊ะนานเท่านี้ (ตอนนี้ 24 ชม.) |

**Pin** (บังคับให้เป็น live ไม่ว่าเงียบนานแค่ไหน): มี approval ค้าง · `standbyWaiters.has(id)` · `status ∈ {waiting, working, compacting}` · `background` ยังมีงาน `running`

**กติกาเพิ่มเติม**

- ประเมินใหม่ทุกครั้งที่มี event และใน sweep ทุก 60 วินาที (ใช้ `setInterval` ที่ `:887` ตัวเดิม)
- ทุกครั้งที่ presence เปลี่ยน → อัปเดต `index.json` และส่ง SSE (§5.3)
- `ENDED_TTL_MS` **เลิกลบข้อมูล** เหลือหน้าที่แค่ปล่อย session ออกจาก `sessions` Map ในหน่วยความจำ ส่วน record ใน index อยู่จนกว่า transcript จะหาย (§6)
- **Resume**: `claude --resume` ใช้ session id เดิม → `SessionStart(source=resume)` → `getSession` เจอ record เดิม → presence กลับเป็น `live` ได้โต๊ะใหม่ และ trail ต่อไฟล์เดิม (ตรงนี้ `getSession` ทำอยู่แล้วกับ `ended`/`stale` ที่ `:171-173`)
- **session ที่ bridge เห็นหลัง restart** (`stale`): presence เป็น `idle` จนกว่าจะมี hook หรือ transcript ขยับ แล้วจึงกลับเป็น `live`

### 4.3 โต๊ะ 42 ตัว

ให้ server ตัดสินลำดับ ไม่ใช่ปล่อยให้ `scene.update` ข้ามเงียบๆ:

1. คนที่มีสิทธิ์ได้โต๊ะ: presence ∈ {`live`, `idle`, `ended`}
2. ลำดับความสำคัญ: มี approval/`waiting`/`error` → `live` → `ended` (ช่วงเดินออก) → `idle` เรียงตาม `lastAt` ล่าสุดก่อน
3. **โต๊ะต้องนิ่ง**: คนที่นั่งอยู่แล้วไม่ถูกย้าย ถ้าเต็มแล้วมี `live` ใหม่เข้ามา → ไล่ `idle` ที่เงียบนานที่สุดออก (avatar เดินออก)
4. ถ้าเต็มไปด้วย `live` ทั้ง 42 → ที่เกินได้ `desk: null` แล้ว UI โชว์ "+N ไม่มีโต๊ะ" ในรายการ session
5. server ส่ง field `desk: true|false` มากับ session snapshot และ `scene.update` นั่งเฉพาะคนที่ `desk: true` (การเลือกว่าโต๊ะไหน ยังเป็นของ scene ตามเดิม)

---

## 5. API contracts

### 5.1 ความปลอดภัย: เหมือนเดิมทุกข้อ

- `Host` ต้องเป็น `127.0.0.1:<port>` หรือ `localhost:<port>` (`:727`)
- ทุก endpoint ใหม่เป็น `POST /api/…` + `Content-Type: application/json` + `X-Office-Token` + เช็ก Origin (`:777-781`) และ body ≤ 100 KB
- **ทำไมไม่ใช้ `GET`**: ถ้าใช้ GET ต้องเปิดช่องให้ token ไปอยู่ใน query string (แบบ `/events`) ซึ่งจะไปค้างใน history ของ browser และ log หรือต้องเขียน guard ชุดใหม่ ใช้ POST คือ reuse guard เดิม 100%
- response มีแต่ `text` ที่ผ่าน `clip()` แล้ว และไม่มี path ของ transcript

### 5.2 Endpoints

#### `POST /api/sessions/list`

request
```json
{ "cursor": null, "q": "office", "limit": 50, "presence": ["live", "idle", "ended", "history"], "includeEmpty": false }
```

response
```json
{
  "items": [
    {
      "id": "0ecc2fc3-…",
      "title": "Claude agent office repository",
      "project": "claude-agent-office",
      "cwd": "E:\\My Second Brain\\Project Code\\claude-agent-office",
      "gitBranch": "main",
      "model": "claude-opus-5-5",
      "presence": "history",
      "status": null,
      "waiting": false,
      "forkedFrom": null,
      "titleSrc": "custom-title",
      "lastPrompt": "Pull Commit ล่าสุดมาให้หน่อยค่ะ",
      "firstAt": 1731050000000,
      "lastAt": 1731571200000,
      "endedAt": null,
      "counts": { "prompts": 33, "tools": 410, "errors": 3 }
    }
  ],
  "next": "eyJsYXN0QXQiOjE3MzE1NzEyMDAwMDAsImlkIjoiMGVjYyJ9",
  "total": 123
}
```

- เรียงตาม `lastAt` ใหม่ก่อน ถ้าเท่ากันใช้ `id`
- **cursor แบบ keyset**: `base64url(JSON{lastAt, id})` → ถ้ามี session ใหม่แทรกเข้ามาระหว่างเลื่อน หน้าไม่ซ้ำและไม่ข้าม (ใช้ offset จะเพี้ยน)
- `limit` default 50, max 200
- **ซ่อน session ว่างเป็นค่าเริ่มต้น**: session ที่ `counts.prompts === 0` (เปิดขึ้นมาแล้วไม่เคยพิมพ์อะไร) จะไม่อยู่ในผลลัพธ์ ยกเว้นส่ง `includeEmpty: true` และ `total` นับตามตัวกรองนี้ด้วย
- **ค้นหา**: substring แบบไม่สนตัวพิมพ์ ใน `title`, `project`, `cwd`, `gitBranch` normalize ด้วย `NFC` + `toLocaleLowerCase()` ก่อน (ภาษาไทยไม่มีตัวพิมพ์เล็ก/ใหญ่ แต่ NFC กันสระ/วรรณยุกต์ที่ประกอบต่างลำดับกัน) ทำในหน่วยความจำได้เลย เพราะมี 123 record
- **การจัดกลุ่มตามวัน ทำฝั่ง client**: server ส่ง ms epoch แล้วให้ browser จัดเป็น "วันนี้ / เมื่อวาน / 8 พ.ย. / เก่ากว่า" ตาม timezone ของเครื่องเอง ถ้า server จัดกลุ่มให้ จะผูก timezone ไว้ที่ server ซึ่งผิดที่

#### `POST /api/sessions/trail`

request
```json
{ "sessionId": "0ecc2fc3-…", "before": null, "limit": 200, "kinds": ["prompt", "tool", "error"] }
```

response
```json
{
  "entries": [
    { "id": "t:6f1e…", "t": 1731571100000, "kind": "prompt", "src": "transcript", "text": "Prompt: Pull Commit ล่าสุดมาให้หน่อยค่ะ" },
    { "id": "t:toolu_01…", "t": 1731571105000, "kind": "tool", "src": "transcript", "text": "Bash · Pull latest commits from remote", "tool": "Bash" }
  ],
  "before": "b2ZmOjQ4MjExMw",
  "building": false
}
```

- อ่านจาก **ท้ายไฟล์ย้อนขึ้นไป** ทีละ chunk 64 KB จนได้ `limit` entry (ข้ามบรรทัด `cursor`) ใน page หนึ่ง เรียงจากเก่าไปใหม่
- `before` = byte offset แบบ opaque (base64url) ไม่ใช่เวลา เพราะเวลาซ้ำกันได้ ส่วน offset ไม่ซ้ำ ไม่มีหน้าแล้ว → `null`
- `kinds` กรองฝั่ง server (หน้าหนึ่งอาจต้องอ่านหลาย chunk) `limit` max 500
- **lazy build**: ถ้า record มี `trailBuilt: false` → เรียก `indexer.build(id)` แล้วรอไม่เกิน 10 วินาที ถ้าไม่ทันคืน `{entries: [], building: true}` แล้วค่อยส่ง SSE `trail-ready` ทีหลัง
- session ไม่มีใน index → `404`

**ลำดับเวลา**: ลำดับในไฟล์คือลำดับที่ append หลัง bridge ดับไป entry จาก transcript (เวลาเก่า) อาจถูก append หลัง entry จาก bridge (เวลาใหม่) → client **sort ตาม `t` ภายในช่วงที่โหลดมาแล้ว** ส่วนที่เพี้ยนข้ามหน้ามีโอกาสน้อยและยอมรับได้

#### ไม่ต้องมี endpoint ใหม่สำหรับ

- `forget` ใช้ `/api/forget` เดิม แต่ความหมายเปลี่ยนเป็น **ไล่ออกจากออฟฟิศอย่างเดียว**: presence → `history` แล้วปล่อยโต๊ะ ส่วน record และ trail ยังอยู่ใน History ครบ (D2)
- ข้อมูล session เดี่ยว: ใช้ข้อมูลจาก list หรือ snapshot ไปเลย

### 5.3 SSE (`/events`)

| `type` | payload | เมื่อไหร่ |
|---|---|---|
| `snapshot` (เดิม, แก้) | `sessions` = เฉพาะ presence ≠ `history` และ **ไม่มี `trail`** · เพิ่ม `indexTotal` | ตอนต่อ SSE |
| `session` (เดิม, แก้) | `publicSession(s)` **ไม่มี `trail`** · เพิ่ม `presence`, `desk`, `title` | ทุก `touch()` |
| `removed` (เดิม, ความหมายเปลี่ยน) | `{id}` | presence → `history` (ออกจากออฟฟิศ **ไม่ได้ลบ**) |
| `index` (ใหม่) | `{op: "upsert", record}` / `{op: "remove", id}` | record ใน History เปลี่ยน (title, lastAt, presence) debounce 1 วินาทีต่อ session |
| `trail` (ใหม่) | `{sessionId, entries: [...]}` | entry ใหม่ถูก append รวมเป็น batch ทุก 250 ms |
| `trail-ready` (ใหม่) | `{sessionId}` | lazy build เสร็จ |
| `trail-reset` (ใหม่) | `{sessionId}` | indexer รายงานว่า transcript ถูก truncate หรือแทนที่ทั้งไฟล์ → store เขียน trail ใหม่โดยทิ้งเฉพาะ entry `src: "transcript"` และ cursor (เก็บ `hook`/`bridge`/`legacy` ไว้ §2.4) เสร็จแล้วจึงส่ง event นี้ แล้ว client ทิ้งของเดิมและโหลดหน้าแรกใหม่ |

- ส่ง `trail` ให้ทุก client โดยไม่กรองตาม session ที่เลือกอยู่ เพราะอยู่บน localhost และปริมาณน้อย (สิบกว่า entry ต่อวินาทีตอนพีค) client เลือกเก็บเฉพาะ session ที่เปิดอยู่เอง
- **เปลี่ยนที่ UI ต้องรู้**: `web/app.js:264` อ่าน `s.trail` จาก session object ตรงๆ ต้องเปลี่ยนไปโหลดผ่าน `/api/sessions/trail` แล้วต่อด้วย SSE `trail` (เป็นงานของ session ที่ออกแบบ UI)

---

## 6. Retention, migration และ restart

### 6.1 อายุของข้อมูลผูกกับ transcript

- indexer รายงาน `gone(id)` (เห็น unlink หรือ scan แล้วไม่เจอไฟล์) → store ลบ `trails/<id>.jsonl` และ record ใน index แล้วส่ง SSE `index remove`
- ข้อยกเว้น: session ที่ presence ≠ `history` ยังไม่ลบ (ยังทำงานอยู่ แค่ไม่เห็นไฟล์) จะลบเมื่อกลายเป็น `history` แล้วเท่านั้น
- session ที่มีแค่ hook ไม่เคยมี transcript (เช่น `transcript_path` ว่าง) → เก็บไว้ `ENDED_TTL_MS` (24 ชม.) หลังจบ แล้วลบ ซึ่งเป็นพฤติกรรมเดิม
- Claude Code ลบ transcript ตาม `cleanupPeriodDays` (ค่าเริ่มต้นที่เข้าใจคือ 30 วัน **ต้องเช็กอีกที**)
- entry ฝั่ง bridge (permission, dispatch, git) หายไปพร้อม transcript ด้วย ไม่มี retention แยก (D3)

### 6.2 Migration จาก `state.json` v1 (ทำครั้งเดียว ตอนเจอไฟล์ที่ไม่มี `v`)

1. copy `state.json` → `state.v1.json.bak`
2. ทุก session ที่มี `trail[]`: เขียนลง `trails/<id>.jsonl` ด้วย `src: "legacy"`, `id: "l:<index>"` **เฉพาะ kind ฝั่ง hook/bridge** (`session` `env` `mode` `notify` `permission` `dispatch` `git` `other` และ `error` ที่ขึ้นต้นด้วย "API error")
   - kind ฝั่ง transcript (`prompt` `skill` `background` `subagent` `error` ของ tool) **ข้าม** เพราะ indexer จะสร้างให้ครบกว่าจาก transcript ถ้า import ไปด้วยจะได้ของซ้ำ
3. สร้าง record ใน `index.json` ให้ session เหล่านั้น (indexer จะเติม title/branch ทีหลัง)
4. เขียน `state.json` v2 (ไม่มี trail)
5. ถ้าขั้นไหนพัง → ไม่แตะ `state.json` เดิม แล้วรันต่อแบบ v1 อ่านอย่างเดียว พร้อม log เตือน (ย้อนกลับได้เพราะมี `.bak`)

### 6.3 ลำดับตอน start / restart

```
1. ยึด bridge.lock                         (ไม่ได้ → exit)
2. โหลด index.json                         → History พร้อมโชว์ทันที
3. โหลด state.json (migrate ถ้าเป็น v1)    → session ที่ค้างอยู่ status = stale, presence = idle (เหมือน :62)
4. server.listen                           → hook เริ่มเข้าได้
5. indexer.start({ cursorOf, scanOf })     → ไฟล์ที่ scan ยังตรงกันข้ามไปเลย ที่เหลืออ่านต่อจาก cursor (background)
     ├─ entry ที่ตกหล่นระหว่าง bridge ดับ → append + SSE trail
     ├─ transcript ไม่ได้ขยับเลย → ไม่มีอะไรเกิด
     └─ เจอ session ใหม่บนดิสก์ → index upsert (presence history หรือ idle ตาม mtime)
6. reconcile: record ใน index ที่ไฟล์หายไปแล้ว → gone()
7. sweep presence ทุก 60 วินาที
```

- **สิ่งที่หายจริงๆ ตอน bridge ดับ**: event ที่มีแค่ใน hook (notify, permission ที่ตอบใน terminal, compaction, `SessionEnd`) เป็นข้อจำกัดของสถาปัตยกรรมที่ยอมรับได้
- ถ้า `SessionEnd` หายไป session นั้นจะเงียบจนครบ `IDLE_WINDOW_MS` แล้วกลายเป็น `history` ไปเอง

---

## 7. Interface ที่ต้องการจาก Transcript Indexer

```
indexer.start({
  cursorOf: (sessionId) => Cursor | null,  // cursor ล่าสุดจากไฟล์ trail
  scanOf:   (sessionId) => Scan | null,    // scan cache จาก index.json (ทางลัดตอน startup)
}) : void

indexer.on('meta',    (rec: { id, transcript, title, titleSrc, cwd, gitBranch, model,
                              firstAt, lastAt, forkedFrom, lastPrompt, scan }) => void)
indexer.on('entries', (sessionId, entries: TrailEntry[], cursor: Cursor) => void)
indexer.on('reset',   (sessionId) => Promise<void>)  // transcript ถูก truncate/แทนที่ → store เขียนไฟล์ trail ใหม่
                                                     // (ทิ้ง src:transcript + cursor, เก็บ hook/bridge/legacy) แบบ atomic
                                                     // resolve หลัง rename เสร็จ → indexer ต้อง await ก่อนยิง entries ชุดแรก
indexer.on('gone',    (sessionId) => void)
indexer.on('health',  ({ healthy: boolean, reason?: string }) => void)

indexer.build(sessionId) : Promise<void>   // parse ทั้งไฟล์ (lazy) แล้วยิง 'entries' ตามปกติ
indexer.track(sessionId, transcriptPath)   // hook SessionStart บอก path ให้ (เผื่อ watcher ยังไม่เห็น)
```

**สิ่งที่ store คาดหวัง (contract)**

1. `entries` ต้อง **redact + clip มาแล้ว** ใช้ `clip()`/`summarizeTool()` ตัวเดียวกับ bridge (แยก `bridge/redact.mjs` ออกมาให้ทั้งสองฝั่งใช้ร่วมกัน)
2. `id` ต้องตรงตาม §2.3 (`t:<uuid>`, `t:<tool_use_id>`, `t:<tool_use_id>:err`) และ deterministic: parse ไฟล์เดิมซ้ำต้องได้ id เดิม
3. ส่งเฉพาะ kind ฝั่ง transcript (`prompt` `tool` `skill` `subagent` `error`) และ **ต้องข้ามข้อความที่ hook ฉีดเข้ามา** (§3.2 ข้อ 2)
4. `entries` กับ `cursor` ต้องมาเป็นคู่กันใน callback เดียว (store เขียนทั้งคู่ใน append ครั้งเดียว) `Cursor` เป็น opaque และเก็บ `ctx` ของ indexer ไว้ข้างในได้ store แค่เก็บเป็น JSON ทึบๆ
5. `scan` ใน `meta` ทาง store เก็บลง record ใน `index.json` ทั้งก้อน แล้วคืนให้ผ่าน `scanOf()` ตอน start ครั้งถัดไป
6. ต้องเรียงตามลำดับในไฟล์ transcript และไม่ยิง `entries` ของ session เดียวกันซ้อนกันก่อน callback ก่อนหน้าจะ resolve (ถ้า callback คืน Promise ต้องรอ)

---

## 8. Load estimate

| | ค่า |
|---|---|
| session ทั้งหมด (วันนี้) | 123 transcript / 58 project |
| `index.json` | ~50 KB |
| trail entries | ~180 B ต่อ entry · session ทั่วไป 100–2,000 entry |
| disk รวม | ต่ำกว่า 50 MB แม้ใช้หนัก (ลดลงเองตาม `cleanupPeriodDays`) |
| SSE `trail` ตอนพีค | ~10–20 entry ต่อวินาที รวมทุก session ส่งเป็น batch ทุก 250 ms |
| `trail` page | อ่านย้อน 1–3 chunk ขนาด 64 KB → ไม่ถึง 5 ms |

ไม่ต้องมี DB, cache หรือ queue ภายนอก Node built-ins พอ ตรงกับหลัก "Zero runtime dependencies" ที่หัวไฟล์ (`:5`)

---

## 9. Trade-offs

| ตัดสินใจ | ได้ | เสีย | ทางเลือกที่ไม่เอา |
|---|---|---|---|
| JSONL ต่อ session | append ถูก, crash-safe ด้วย cursor-in-file, ลบตาม transcript ง่าย, ไม่มี dependency | ค้นหาข้าม session ในเนื้อ trail ไม่ได้ | SQLite (`node:sqlite` ใช้ไม่ได้ทุกเวอร์ชันตาม `engines: node>=18`) |
| cursor ไว้ในไฟล์ trail | entry กับ offset อยู่หรือหายพร้อมกัน ไม่ต้องจำ set ของ id | ฝั่งอ่านต้องข้ามบรรทัดที่ไม่ใช่ entry | ไฟล์ offsets แยก (ต้อง dedupe ตอน crash) |
| แหล่งเดียวต่อ kind | ไม่มีโค้ด dedupe, เหตุผลชัด | trail ของ prompt/tool พึ่ง indexer (กันไว้ด้วย degraded mode) | เขียนทั้งสองแหล่งแล้วจับคู่ด้วย `tool_use_id` (prompt ไม่มี id ร่วมกัน จับคู่ได้ไม่ครบ) |
| POST สำหรับอ่าน | reuse guard เดิม, token ไม่อยู่ใน URL | ไม่ RESTful, cache ของ browser ใช้ไม่ได้ (ไม่ได้ต้องการอยู่แล้ว) | GET + token ใน query |
| `presence` แยกจาก `status` | UI และ scene เดิมไม่พัง | มีสอง field ที่ต้องเข้าใจ | ยัด `history`/`idle` ลงใน `status` (ชน `idle` เดิมที่แปลว่าว่างระหว่าง turn) |
| ส่ง SSE `trail` ทุก session | server ง่าย ไม่ต้องรู้ว่าใครเลือกอะไร | bandwidth เกินจำเป็นเล็กน้อย (localhost) | subscribe ราย session |
| `ENDED_DESK_MS` 15 นาที (D1) | โต๊ะไม่เต็มไปด้วยคนที่จบแล้ว | ต่างจากวันนี้ (24 ชม.) | คงไว้ 24 ชม. |

---

## 10. Assumptions (ต้องจริงถึงจะใช้แบบนี้ได้)

1. `session_id` ของ hook = ชื่อไฟล์ transcript (`<id>.jsonl`) และ resume แล้วใช้ id เดิม
2. tool_use ใน transcript มี `id` ตรงกับ `tool_use_id` ของ hook (ใช้แค่ตอน debug ไม่ได้ใช้ dedupe)
3. HTTP hook ไม่ถูก retry
4. bridge มี process เดียวต่อ `DATA_DIR`
5. ค่าเริ่มต้นของ `cleanupPeriodDays` = 30 วัน (ยังไม่ได้ยืนยัน)

## 11. สิ่งที่ตกลงกับ session ออกแบบ Indexer

- **cursor-in-trail-file** (§2.4): indexer ไม่ต้องเก็บ offset เอง แต่รับ `cursorOf()` จาก store และ cursor เป็น opaque ที่เก็บ `ctx` ไว้ได้
- **scan cache** อยู่ใน record ของ `index.json` (`scan`) ไม่มี `transcripts.json` แยก
- การข้ามข้อความที่ hook ฉีดเข้ามา (§3.2 ข้อ 2) เป็นงานของ indexer
- แยก `redact`/`clip`/`summarizeTool` ไปไว้ใน module ที่ใช้ร่วมกัน

## 12. Decisions (2026-11-14)

พี่เอิร์ธอนุมัติแล้ว ใช้เอกสารนี้เป็น baseline

| # | เรื่อง | ตัดสินใจ |
|---|---|---|
| D1 | session ที่จบแล้วอยู่ที่โต๊ะนานแค่ไหน | `ENDED_DESK_MS` = **15 นาที** แล้วย้ายเข้า History |
| D2 | ปุ่ม Forget | **ไล่ออกจากออฟฟิศอย่างเดียว** ยังอยู่ใน History ครบ |
| D3 | บันทึกฝั่ง office (permission, dispatch, git) | **หายไปพร้อม transcript** ไม่มี retention แยก |
| D4 | ช่วง idle | `IDLE_WINDOW_MS` = **60 นาที** |
| D5 | โต๊ะเต็ม 42 ตัว | **ไล่ `idle` ที่เงียบนานที่สุดออก** ให้ session `live` ที่เข้ามาใหม่ |
| D6 | scan cache | `scan: {size, mtimeMs, headHash, parserVersion}` อยู่ใน `index.json` (เจ้าของคือ indexer) ไม่มี `transcripts.json` และ cursor เป็น opaque ที่มี `ctx` ของ indexer |
| D7 | field เพิ่มใน index record | `waiting`, `forkedFrom`, `lastPrompt` (clip 80) และ `titleSrc` รับค่า `ai-title` เพิ่ม |
| D8 | SSE | เพิ่ม `trail-reset {sessionId}` และคง `trail-ready` ไว้ |
| D9 | `POST /api/sessions/list` | ซ่อน session ที่ `counts.prompts === 0` เป็นค่าเริ่มต้น ยกเว้นส่ง `includeEmpty: true` |
| D10 | trail ของ session ย้อนหลัง | **ไม่มี** `env` / `mode` / compaction เพราะ hook ไม่เคยเห็น session เหล่านั้น (ยอมรับแล้ว ดู §3.1) |
| D11 | reset ของ trail | เขียน `trails/<id>.jsonl` ใหม่แบบ atomic (tmp + rename + retry `EPERM`) ภายใน `writeQueue` ของ session นั้น **เก็บ** entry `src` = `hook`/`bridge`/`legacy` และ **ทิ้ง** `src: "transcript"` กับบรรทัด `cursor` ทุกบรรทัด resolve `reset` หลัง rewrite เสร็จและก่อน `entries` ชุดแรกของการ rebuild แล้วจึงส่ง SSE `trail-reset` เป็นข้อยกเว้นเดียวที่ไฟล์ไม่ได้เป็น append-only (§2.4) |
| D12 | หา cursor ตอนเปิดไฟล์ | อ่านย้อนจากท้ายไฟล์ทีละ chunk 64 KB จนกว่าจะเจอ cursor หรือถึงต้นไฟล์ (ไม่ใช่แค่ 64 KB สุดท้าย) เพราะ entry จาก hook/bridge อาจสะสมต่อจาก cursor ตัวสุดท้าย (§2.4) |

## 13. เมื่อระบบโตขึ้น ค่อยกลับมาดู

- ถ้าเกินราว 1,000 session หรืออยากค้นหาในเนื้อ trail → ย้ายเป็น SQLite + FTS (schema ใน §2 map ได้ตรงๆ)
- ถ้าจะรองรับ cloud session → `src` เพิ่มเป็น `relay` และ index record ต้องมี `origin`
- ถ้า transcript format เปลี่ยนบ่อย → พิจารณาให้ hook เป็นแหล่งหลักของ trail ฝั่ง live แล้วใช้ indexer แค่ backfill
