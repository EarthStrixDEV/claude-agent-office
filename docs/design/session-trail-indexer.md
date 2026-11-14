# Session Trail · Component 1: Transcript Indexer

`bridge/transcripts.mjs` อ่าน transcript ของ Claude Code ใต้ `~/.claude/projects/` แล้วส่งออกสองอย่าง

1. **Session meta**: title, cwd, branch, เวลา, model และ fork-of ส่งให้ store เก็บใน `index.json` เพื่อทำ History
2. **Trail entries**: entry ที่ย่อและ redact แล้ว เฉพาะ kind ฝั่ง transcript ส่งให้ store เขียนลง `trails/<id>.jsonl` พร้อม cursor

เอกสารนี้เป็นงานออกแบบอย่างเดียว ยังไม่มีโค้ด เอกสารคู่กันคือ [session-trail-store-api.md](session-trail-store-api.md) ถ้าสองฉบับขัดกัน **ให้ store-api เป็นหลัก** ตัวเลขทั้งหมดวัดจากเครื่องของพี่เอิร์ธเมื่อ 2026-11-14 ด้วยสคริปต์อ่านอย่างเดียวที่พิมพ์แค่สถิติ ไม่พิมพ์เนื้อหา

---

## 0. Decisions (2026-11-14)

พี่เอิร์ธอนุมัติแล้ว ส่วนอื่นของเอกสารนี้แก้ให้ตรงกับข้อเหล่านี้หมดแล้ว

1. **Offset:** ไม่มีไฟล์ `transcripts.json` cursor อยู่ใน `trails/<id>.jsonl` และถูกเขียนใน append เดียวกับ entry (store §2.4) ค่า `ctx` ของ indexer (`model`, `permissionMode`, `gitBranch`, `cwd`) ฝังอยู่ใน cursor ซึ่ง store มองเป็นก้อน JSON ทึบ ส่วนข้อมูลแคชของการสแกน (`size`, `mtimeMs`, `headHash`, `parserVersion`) อยู่ใน record ของ `index.json` ใต้ key `scan` และ indexer เป็นเจ้าของ
2. **ผลของ tool ไม่ใช้ upsert/patch:** ตอนเรียก tool สร้าง `t:<tool_use_id>` ถ้า `tool_result` มี `is_error` ให้เพิ่ม entry `t:<tool_use_id>:err` แยกอีกอัน และไม่มี field `ok`
3. **Kind ที่ indexer ส่งออก** มีแค่ `prompt`, `tool`, `skill`, `subagent` และ `error` (ฝั่ง tool) ส่วน env, mode, compaction, permission, background, cwd จาก relocated, model และ branch เป็นของ hook ทั้งหมด indexer ยังอ่าน relocated, model และ branch ไปใส่ใน meta ได้ indexer ต้องข้ามข้อความที่ hook ฉีดเข้ามา และ**ยอมรับว่า session ย้อนหลังจะไม่มี env trail**
4. **Prefix ของ `id`:** `t:<uuid>`, `t:<tool_use_id>` และ `t:<tool_use_id>:err`
5. **Interface ตาม store §7:** `start({ cursorOf })`, `on('meta' | 'entries' (id, entries, cursor) | 'gone' | 'health')`, `build(id)` และ `track(id, path)` ส่วน `stats()` ยังมีได้แต่ต้องป้อนข้อมูลให้ `health` เมื่อเจอไฟล์ถูกตัดหรือถูกแทนที่ ให้ส่ง `reset` เพื่อให้ store ส่ง SSE `trail-reset`
6. **Q1:** ไม่เก็บคำตอบของ assistant
7. **Q2:** subagent แสดงแค่สรุป ไม่เจาะลงไปดู trail ข้างใน (รายละเอียดใน §2.4)
8. **Q3:** ตัด prompt ที่ 120 ตัวอักษร
9. **Q4:** ซ่อน session ที่ไม่มี prompt โดยกรองที่ระดับ API แต่ indexer ยังส่ง meta ให้ครบ และใส่ `prompts: 0` ไว้ให้กรองได้
10. **Q5:** ยังไม่แสดง fork เป็นลูกของ parent แต่เก็บ `forkedFrom` ไว้ใน meta
11. **Q6:** ย้าย `redact`, `clip`, `summarizeTool` ไปไว้ที่ `bridge/redact.mjs`
12. **Q7:** แก้ README ข้อ "no transcript parsing" ([README.md:18](../../README.md)) ใน PR ของ indexer

---

## 1. สิ่งที่วัดได้จริง

| รายการ | ค่า |
|---|---|
| ไฟล์ session หลัก `<project>/<sessionId>.jsonl` | 126 ไฟล์ รวม 253 MB |
| ขนาดไฟล์ | p50 1.0 MB · p90 4.8 MB · ใหญ่สุด 20.1 MB |
| ไฟล์ subagent `<project>/<sessionId>/subagents/agent-*.jsonl` | 729 ไฟล์ รวม 487 MB (มากกว่าไฟล์หลักเกือบ 2 เท่า) |
| ไฟล์ `subagents/agent-*.meta.json` | 546 ไฟล์ |
| จำนวนบรรทัดในไฟล์หลัก | 95,821 บรรทัด และ parse พัง 0 บรรทัด |
| บรรทัดยาวสุด | 1.2 MB |
| อ่านเต็มทุกไฟล์ + `JSON.parse` ทุกบรรทัด (sync) | 4.9 วินาที หรือประมาณ 19 ms ต่อ MB |
| อ่านหัว 16 KB + ท้าย 64 KB ทุกไฟล์ | 108 ms |
| เวอร์ชันที่พบ | `2.1.160` ถึง `2.1.321` (31 เวอร์ชัน) และ `entrypoint` เป็น `claude-desktop` ทั้งหมด |
| Node บนเครื่อง | v26.5.0 (`package.json` กำหนด `>=18`) |

ข้อสังเกตที่มีผลต่อการออกแบบ

- **title:** มีทั้ง `custom-title` (118 ไฟล์) และ `ai-title` (56 ไฟล์) แต่ 7 ไฟล์ไม่มีทั้งคู่ ใน 118 ไฟล์ที่มี `custom-title` มี 115 ไฟล์ที่ตัวล่าสุดอยู่ใน 64 KB ท้ายไฟล์ บรรทัด title ถูกเขียนซ้ำตลอด session และตัวล่าสุดคือค่าจริง
- **`cwd`, `gitBranch`, `timestamp`:** ทั้ง 126 ไฟล์มีค่าเหล่านี้ภายใน 20 บรรทัดแรก
- **Fork:** 6 ไฟล์ขึ้นต้นด้วยบรรทัดของ session อื่น `sessionId` ไม่ตรงกับชื่อไฟล์ และ session นั้นก็มีไฟล์ของตัวเองอยู่แล้ว บรรทัดพวกนี้เป็นสำเนาประวัติจาก parent ตอน fork และอยู่ก่อนบรรทัดของตัวเองทั้งหมด
- **`relocated`:** พบใน 21 ไฟล์ แปลว่า cwd ของ session เปลี่ยนแต่ไฟล์ยังอยู่โฟลเดอร์เดิม ชื่อโฟลเดอร์ project (`E--My-Second-Brain-...`) แปลงกลับเป็น path ไม่ได้แน่นอน **จึงต้องใช้ field `cwd` และ `relocatedCwd` เท่านั้น**
- **ไม่มี sidechain ในไฟล์หลัก:** subagent แยกไปอยู่ไฟล์ของตัวเองแล้ว ทุกบรรทัดในนั้นมี `isSidechain:true` และ `agentId`
- **`attachment` คือ 29% ของบรรทัด:** ส่วนใหญ่เป็น `async_hook_response` (14,488) และ `total_tokens_reminder` (5,581) ไม่มีค่าสำหรับ trail
- **ข้อความที่ hook ฉีดเข้ามาอยู่ที่ไหน:** หนูนับบรรทัดที่มี `hookAdditionalContext` / `hook_additional_context` ได้ดังนี้

  | ตำแหน่ง | จำนวน |
  |---|---|
  | `system` subtype `stop_hook_summary` | 1,372 |
  | `attachment` type `hook_additional_context` | 305 |
  | `user` ที่เป็น `isMeta` | 1 |

  **ไม่พบใน `user` prompt ปกติเลย** บรรทัดที่มีคำว่า "Minju's desk" ที่เหลือเป็น `tool_use` / `tool_result` ของงานที่อ่านโค้ด repo นี้เอง กฎข้ามใน §2.1 จึงครอบคลุมการ dedupe ตาม store §3.2 ข้อ 2 แล้ว
- **`hook_non_blocking_error`:** พบ 270 ครั้ง น่าจะเป็น hook ของ Agent Office เองที่ยิงตอน bridge ปิดอยู่ (ยังไม่ได้ยืนยัน)

---

## 2. Parser adapter: map บรรทัดเป็น entry

parser ทั้งหมดอยู่ในฟังก์ชันเดียว `parseLine(obj, ctx) → { entries, meta }` ซึ่งเป็นจุดเดียวที่รู้จัก format ภายในของ transcript

### 2.1 กติการะดับบรรทัด (เช็กตามลำดับ)

1. ถ้า parse JSON ไม่ได้ ให้นับใน `stats.badLines` แล้วข้าม
2. ถ้า `obj.sessionId` ไม่ตรงกับชื่อไฟล์ ให้ใส่ `forkedFrom = obj.sessionId` ใน meta แล้วข้าม เพราะบรรทัดนั้นเป็นของ parent อยู่แล้ว
3. ถ้า `obj.isSidechain === true` ให้ข้าม (กันไว้เผื่อรูปแบบเก่าที่ subagent ยังอยู่ในไฟล์หลัก)
4. **ข้ามข้อความที่ hook หรือระบบฉีดเข้ามา:**
   - `system` ทุก subtype รวม `stop_hook_summary` ที่มี `hookAdditionalContext`
   - `attachment` ทุก type รวม `hook_additional_context`
   - `user` ที่เป็น `isMeta`
   - `user` ที่เป็น string และขึ้นต้นด้วย `<system-reminder>`, `<command-message>`, `<local-command-stdout>`, `<local-command-caveat>`, `<task-notification>` หรือ `<bash-input>`
5. ถ้าเป็น type ที่ไม่รู้จัก ให้นับใน `stats.unknownTypes[type]` แล้วข้าม และ log เตือนครั้งเดียวต่อ type ตลอดอายุ process (แบบเดียวกับ commit "Log refused Host headers once")

### 2.2 ตาราง mapping (entry ที่ส่งออก)

| บรรทัด | เงื่อนไข | entry | `id` |
|---|---|---|---|
| `user` content เป็น string | ไม่ใช่ `isMeta` ไม่ขึ้นต้นด้วย tag ในข้อ 2.1.4 และไม่ใช่ `isCompactSummary` | `prompt` · `clip(text, 120)` | `t:<uuid>` |
| `user` content เป็น array ของ `text`/`image` | เงื่อนไขเดียวกัน | `prompt` · ข้อความ + `[n images]` | `t:<uuid>` |
| `user` ขึ้นต้นด้วย `<command-name>` | | `skill` · `/name args` (ดึงจาก `<command-name>`, `<command-args>`) | `t:<uuid>` |
| `assistant` block `tool_use` | `name` เป็น `Skill` | `skill` · `summarizeTool` + `tool: 'Skill'` | `t:<block.id>` |
| | `name` เป็น `Agent`/`Task` | `subagent` · `summarizeTool` + `agent: input.subagent_type` | `t:<block.id>` |
| | อื่นๆ | `tool` · `<name> · summarizeTool(name, input)` + `tool: name` และ `bg: true` ถ้า `input.run_in_background` | `t:<block.id>` |
| `user` block `tool_result` ที่ `is_error: true` | | `error` · `<tool> failed: clip(บรรทัดแรก, 120)` (ชื่อ tool ได้จาก map `tool_use_id → name` ใน `ctx`) | `t:<tool_use_id>:err` |
| `user` block `tool_result` ที่สำเร็จ | | ไม่สร้าง entry | |
| `assistant` block `text` / `thinking` | | ข้าม (Q1: ไม่เก็บ) | |
| `assistant` ที่เป็น API error | | ข้าม เพราะ `error` ฝั่ง API เป็นของ hook `StopFailure` | |
| `user` ที่มี `toolDenialKind` | | ข้าม เพราะ permission เป็นของ bridge/hook | |

ตารางนี้มีแค่ 5 kind ที่ตกลงกันไว้ ห้ามเพิ่ม kind อื่นโดยไม่แก้ store §3.1 ไปพร้อมกัน

### 2.3 บรรทัดที่ใช้อัปเดต meta อย่างเดียว (ไม่สร้าง entry)

| บรรทัด / field | ใส่ใน meta |
|---|---|
| `custom-title`, `ai-title` | `title`, `titleSrc` (`custom-title` ชนะ `ai-title` และถ้าไม่มีทั้งคู่ใช้ `first-prompt`) |
| `relocated` | `cwd = relocatedCwd` |
| `cwd`, `gitBranch` บนทุกบรรทัด | `cwd`, `gitBranch` (เอาค่าล่าสุด) |
| `requestedModel` บน `assistant` | `model` |
| `timestamp` | `firstAt`, `lastAt` |
| entry `prompt` ที่ส่งออก | `prompts` (จำนวน ใช้กรองตาม Q4) |
| `version` | `versionMin`, `versionMax` (ใช้กับ §2.6) |
| `last-prompt`, `cost-state` | ไม่ใช้ตอนนี้ store §2.2 ไม่มี field รองรับ |

`ctx` คือค่าล่าสุดของ `model`, `permissionMode`, `gitBranch`, `cwd` และ map `tool_use_id → name` ของ tool ที่ยังไม่ได้ผลลัพธ์ จำกัดไว้ 256 รายการ ค่านี้ถูกฝังไว้ใน cursor (§4.4) เพื่อให้การอ่านต่อหลัง restart ได้ meta ที่ถูกต้อง และยังตั้งชื่อ tool ใน entry `:err` ได้แม้ `tool_use` จะอยู่ใน chunk ก่อนหน้า

### 2.4 Subagent (Q2: แสดงแค่สรุป)

- **ไม่ parse** `subagents/agent-*.jsonl` ซึ่งรวมกัน 487 MB
- entry `subagent` ใช้ `input.subagent_type` กับ `input.description` จาก `tool_use` ตัวแม่ ซึ่งเป็นค่าเดียวกับ `agentType` และ `description` ใน `agent-*.meta.json` จึงไม่ต้องอ่าน meta.json เลย
- **ผลข้างเคียงของ decision 2:** entry ถูกเขียนครั้งเดียวและแก้ทีหลังไม่ได้ จึงไม่มีสถานะ "จบแล้ว" (`finished`) ใน trail ถ้า subagent ล้มเหลว จะได้ entry `t:<id>:err` ตามกฎของ tool ปกติ ส่วนสถานะ live ของ subagent ยังมาจาก hook `SubagentStart`/`SubagentStop` เหมือนเดิม
- watcher ใช้ไฟล์ใต้ `subagents/` แค่เป็นสัญญาณว่า session ยังทำงานอยู่ (§4.1)

### 2.5 Entry ที่ส่งออก (ตาม store §2.3)

```js
{ id, t, kind, src: 'transcript', text, tool?, agent?, bg? }
// t = Date.parse(obj.timestamp)
// text ≤ 200 ตัวอักษร ผ่าน clip() → redact() มาแล้วทุกครั้ง
```

- **deterministic:** parse ไฟล์เดิมซ้ำต้องได้ `id` เดิมทุกครั้ง เพราะ `id` มาจาก `uuid` / `tool_use_id` ในไฟล์ ไม่ได้มาจากลำดับหรือเวลาที่ ingest
- **ส่งตามลำดับ:** entry ถูกส่งตามลำดับในไฟล์ transcript และจะไม่ยิง `entries` ของ session เดียวกันซ้อนกัน ต้องรอ callback ก่อนหน้า (หรือ Promise ที่คืนมา) resolve ก่อน (store §7 ข้อ 5)

### 2.6 การจัดการเวอร์ชัน

- **`PARSER_VERSION`:** ค่าคงที่ในโมดูลที่ถูกเก็บไว้ใน `scan.parserVersion` ถ้าค่าไม่ตรงกับที่เก็บไว้ จะถือว่าไฟล์นั้นถูกแทนที่ และ reset แล้ว build ใหม่ (§4.5)
- **`TESTED_RANGE`:** ตั้งเป็น `2.1.160`–`2.1.321` ถ้าเจอ `version` นอกช่วงนี้ยัง parse ตามปกติ แต่รายงานผ่าน `health` ด้วย `reason: 'untested-version'` (ยังถือว่า `healthy: true`)
- **ไม่ผูกกับลำดับ key:** ลำดับ key ในแต่ละบรรทัดไม่คงที่ บรรทัด `user` ขึ้นต้นด้วย `parentUuid` แต่บรรทัดอื่นขึ้นต้นด้วย `type` ห้ามใช้ prefix string แทนการ parse ยกเว้นการหา title ใน §3.2
- **Fixtures สังเคราะห์:** ทำจากรูปแบบที่สำรวจไว้ข้างบน ไม่ใช้ transcript จริงเพราะมีข้อมูลส่วนตัว ทุกแถวใน §2.2 และทุกกฎข้ามใน §2.1 ต้องมีอย่างน้อย 1 fixture

---

## 3. Startup scan

### 3.1 แบ่งเป็นสองระดับ

| ระดับ | เกิดเมื่อไร | อ่านอะไร | ต้นทุน |
|---|---|---|---|
| **Index** | ทุกไฟล์ ตอน `start` | `stat` + 16 KB หัวไฟล์ (`cwd`, `gitBranch`, `version`, ts แรก, `forkedFrom`) + 64 KB ท้ายไฟล์ (title, ts ล่าสุด, model) แล้วส่ง `meta` | ~108 ms สำหรับ 126 ไฟล์ |
| **Build** | (a) `cursorOf(id)` มีค่าอยู่แล้ว แปลว่าเคย build และต้องอ่านต่อ, (b) store เรียก `build(id)` เพราะมีคนเปิด trail, (c) ไฟล์ขยับระหว่างที่ bridge รัน, (d) store เรียก `track(id, path)` จาก hook `SessionStart` | ทั้งไฟล์หรือต่อจาก cursor แบบ stream แล้วส่ง `entries` | ~19 ms/MB → ไฟล์ 20 MB ใช้ประมาณ 400 ms |

`prompts` ใน meta ของ session ที่ยังไม่เคย build ยังไม่รู้ (`null`) API ที่กรองตาม Q4 จึงต้องถือ `null` เป็น "ยังไม่รู้ ให้แสดงไว้ก่อน" แล้วค่อยซ่อนเมื่อ build แล้วได้ 0 อีกทางคือให้ index scan นับ prompt แบบถูกๆ ด้วยการหา `"type":"user"` ที่ไม่ใช่ `tool_result` ระหว่างอ่านหัวไฟล์ แต่ผลจะไม่แม่นสำหรับไฟล์ใหญ่ ตอนนี้หนูเลือกแบบแรก

### 3.2 กรณีที่หา title ใน 64 KB ท้ายไม่เจอ

พบ 3 จาก 118 ไฟล์ ให้ขยายหน้าต่างเป็น 512 KB ก่อน ถ้ายังไม่เจอค่อยสแกนทั้งไฟล์ด้วย `indexOf('"customTitle"')` บน Buffer โดยไม่ parse JSON แล้ว parse เฉพาะบรรทัดที่เจอ

ถ้าไม่มี title จริงๆ (7 ไฟล์) ให้ใช้ `clip(prompt แรก, 60)` (`titleSrc: 'first-prompt'`) และถ้าไม่มี prompt เลยให้ใช้ `basename(cwd) · id.slice(0, 8)`

### 3.3 Fast path ตอน restart

store โหลด `index.json` ก่อนเรียก `start` (store §6.3) indexer อ่าน `scan` ของแต่ละ record ที่ส่งกลับมาผ่าน meta ถ้า `size`, `mtimeMs` และ `parserVersion` ตรงกันทั้งหมด จะข้ามไฟล์นั้นไปเลย การ start ครั้งที่สองจึงเหลือแค่ `stat` 126 ครั้ง ไม่ถึง 20 ms

store ต้องส่ง `scan` ให้ indexer ด้วย หนูเสนอให้ `cursorOf` ฝั่ง indexer คู่กับ `scanOf(id)` ที่ store เพิ่มเข้ามา เพราะ store §7 ตอนนี้ยังไม่มีช่องนี้ (ดูข้อ 1 ใน §10)

### 3.4 เป้าหมาย

- meta ครบทุก session ภายใน **300 ms** ตอน cold start (cache ของ OS ว่าง) สำหรับ 126 ไฟล์ และภายใน 1 วินาทีสำหรับ 1,000 ไฟล์
- ใช้ `fs.promises` อ่านพร้อมกันได้ 8 ไฟล์ `start()` ไม่บล็อก `listen` (store §6.3 ขั้น 4 มาก่อนขั้น 5)
- การ build **ห้ามบล็อก event loop** เกิน ~50 ms ต่อรอบ เพราะ hook `PreToolUse` มี timeout 5 วินาที และต้องตอบ permission ได้ทันที ให้อ่านทีละ chunk 1 MB ด้วย `FileHandle.read`, parse เป็นช่วงประมาณ 2,000 บรรทัด แล้ว `await setImmediate()` คั่น และส่ง `entries` ทีละ chunk พร้อม cursor ของ chunk นั้น
- ห้ามใช้ `readFileSync` ทั้งไฟล์แบบที่สคริปต์วัดผลใช้
- ถ้าต้อง build หลายไฟล์พร้อมกัน ให้ต่อคิวทีละไฟล์

**ทางเลือกที่ไม่เลือก:** `worker_threads` แยกได้ดีกว่า แต่ต้อง serialize entry ข้าม thread และเพิ่มความซับซ้อน ถ้าวัดแล้วการ yield ด้วย chunk พอ ก็ไม่ต้องใช้ ควรกลับมาพิจารณาเมื่อไฟล์ใหญ่เกิน 100 MB

---

## 4. Live tailing

### 4.1 Watcher

```
fs.watch(ROOT, { recursive: true }, (event, filename) => route(filename))
```

- Windows กับ macOS รองรับ recursive ตั้งแต่ Node 18 และ Linux ตั้งแต่ Node 20
- `route` แยกตาม path

| path | การจัดการ |
|---|---|
| `<proj>/<id>.jsonl` (ความลึก 2) | ไฟล์หลัก → tail ถ้า build แล้ว ถ้ายังไม่ build ให้ build (เงื่อนไข c ใน §3.1) |
| `<proj>/<id>/subagents/*` | ส่ง `meta` ที่อัปเดตแค่ `lastAt` ของ session แม่ เพื่อบอกว่ายังทำงานอยู่ โดยไม่ parse ไฟล์ |
| อื่นๆ | ข้าม |

- **`filename` เป็น `null`:** เกิดได้บน Windows เมื่อ buffer ของ `ReadDirectoryChangesW` ล้น ให้ถือเป็นสัญญาณ "rescan": `stat` ไฟล์ที่รู้จักทั้งหมดแล้ว tail ไฟล์ที่ขนาดเปลี่ยน
- **watcher ส่ง `error` หรือหยุดทำงาน:** ส่ง `health { healthy: false, reason: 'watcher' }` ปิด watcher แล้วสร้างใหม่ โดยหน่วงเวลาแบบ backoff 1s → 2s → … สูงสุด 30s ระหว่างนั้นใช้ safety poll แทน และเมื่อกลับมาได้ให้ส่ง `healthy: true`
- **Safety poll ทุก 30 วินาที:** `stat` เฉพาะไฟล์ที่ `mtime` อยู่ในช่วง 1 ชั่วโมงล่าสุด (ปกติไม่กี่ไฟล์) เพราะ `fs.watch` บน Windows ทำ event หล่นได้ ทำให้ระบบไม่พึ่ง watcher อย่างเดียว
- **`track(id, path)`:** เพิ่มไฟล์เข้ารายการที่ต้องเฝ้าทันทีเมื่อ hook `SessionStart` มาถึงก่อน watcher เห็นไฟล์ ถ้าไฟล์ยังไม่ถูกสร้าง ให้ลองใหม่ในรอบ poll ถัดไป

### 4.2 Debounce

ใช้ debounce ต่อไฟล์ **trailing 150 ms** และ **max wait 1 วินาที** ตอน Claude กำลัง stream คำตอบ ไฟล์จะถูกเขียนถี่มาก max wait ทำให้ timeline ยังไหลทุก 1 วินาที ไม่ต้องรอจนเงียบ (store รวม batch SSE ทุก 250 ms อยู่แล้ว)

ในแต่ละไฟล์ อนุญาตให้มีการ tail ได้ทีละครั้ง ถ้ามี event เข้ามาระหว่างที่กำลัง tail ให้ตั้ง flag `again` แล้วอ่านอีกรอบเมื่อรอบปัจจุบันจบ

### 4.3 อ่านต่อจาก cursor และจัดการบรรทัดที่ยังเขียนไม่จบ

```
cursor = cursorOf(id)                      // จาก trails/<id>.jsonl ที่ store อ่านไว้
size   = stat.size
if size < cursor.off or headHash(4 KB แรก) ≠ scan.headHash → reset (4.5)
read [cursor.off, size) เป็น Buffer ทีละ chunk 1 MB
หา 0x0A ตัวสุดท้าย → ประมวลเฉพาะส่วนก่อนหน้า
emit('entries', id, entries, { off: หลัง \n ตัวสุดท้าย, size, mtime, ctx })
ส่วนที่เหลือ (บรรทัดที่ยังไม่จบ) ไม่เก็บไว้ รอบหน้าค่อยอ่านใหม่จาก off
```

- **แยกบรรทัดระดับ Buffer:** ต้องแยกด้วย byte `0x0A` ก่อน decode UTF-8 เพื่อไม่ให้ตัวอักษรไทยหรือ emoji ถูกตัดกลางตัว
- **บรรทัดยาวเกิน chunk:** ถ้าอ่านไปแล้วยังไม่เจอ `\n` ให้ขยาย buffer ต่อ เพราะบรรทัดยาวสุดที่พบคือ 1.2 MB
- **เพดานความยาว 32 MB:** ถ้าบรรทัดยาวเกิน ให้ข้ามไปที่ `\n` ถัดไปแล้วนับใน `stats.oversizeLines` กันหน่วยความจำระเบิดถ้าไฟล์เสีย
- **chunk ที่ไม่มี entry เลย:** ยังต้องส่ง `entries` ด้วย array ว่างพร้อม cursor ใหม่ เพื่อให้ cursor ขยับไปข้างหน้า เพราะไฟล์ส่วนใหญ่เป็น `attachment` และบรรทัด internal ถ้าไม่ส่ง รอบหน้าจะ parse ช่วงเดิมซ้ำทุกครั้ง store จะเลือกเองว่าจะเขียนบรรทัด cursor อย่างเดียวหรือรอรวมกับ batch ถัดไป

### 4.4 สิ่งที่ indexer เก็บถาวร (ตาม decision 1)

**Cursor** อยู่ในบรรทัด `{"cursor": …}` ของ `trails/<id>.jsonl` store เขียนให้ใน append เดียวกับ entry และ store มองเป็นก้อนทึบ

```json
{"cursor":{"off":482113,"size":482113,"mtime":1731571209000,
  "ctx":{"model":"claude-opus-5-5","permissionMode":"auto","gitBranch":"main",
         "cwd":"E:\\…","pending":{"toolu_01AbC":"Edit"}}}}
```

**Scan cache** อยู่ใน record ของ `index.json` ใต้ key `scan` ส่งไปให้ store ผ่าน `meta`

```json
"scan": { "size": 2048123, "mtimeMs": 1731571200000, "headHash": "sha1 ของ 4 KB แรก", "parserVersion": 1 }
```

- **ไม่มีไฟล์ของ indexer เองใน `DATA_DIR`:** ความคงทนทั้งหมดมาจาก store ดังนั้น crash ระหว่างทางจะไม่ทำให้ entry ซ้ำ (store §2.4 ข้อ 4)
- **`scan` ใช้เพื่อความเร็วเท่านั้น:** ถ้าหายหรือเสีย ผลคือต้องอ่านหัวกับท้ายไฟล์ใหม่ ไม่เสียความถูกต้อง
- **ความถูกต้องของการอ่านต่ออยู่ที่ cursor:** session ที่ไม่มี cursor ถือว่ายังไม่ build

### 4.5 ไฟล์ถูกลบ ถูกตัด หรือถูกแทนที่

| สถานการณ์ | ตรวจจับ | ทำอะไร |
|---|---|---|
| ไฟล์ถูกลบ (Claude Code ลบตาม `cleanupPeriodDays`) | event `rename` แล้ว `stat` ได้ `ENOENT` หรือ rescan ไม่เจอไฟล์ | `emit('gone', id)` แล้ว store จะเลือกเองว่าลบเมื่อไหร่ตามกติกา presence (store §6.1) |
| ไฟล์เล็กลง (`size < cursor.off`) | `stat` | `emit('reset', id)` → store ล้างเฉพาะ entry ที่ `src: 'transcript'` และส่ง SSE `trail-reset` → indexer build ใหม่จาก 0 |
| ไฟล์ถูกแทนที่แต่ขนาดใหญ่ขึ้น | `headHash` ไม่ตรงกับ `scan` | เหมือนบรรทัดบน |
| `PARSER_VERSION` เปลี่ยน | ไม่ตรงกับ `scan.parserVersion` | เหมือนบรรทัดบน |
| session ถูก `relocated` | บรรทัด `relocated` ในไฟล์เดิม ไฟล์ไม่ย้าย | อัปเดต `cwd` ใน meta อย่างเดียว |

- **ลำดับ event ตอน reset:** ต้องส่ง `reset` และรอให้ resolve ก่อน จึงค่อยส่ง `entries` ชุดแรกของการ build ใหม่ (ไม่ซ้อนกัน ตาม store §7 ข้อ 5) ตอน reset store ต้องไม่ลบ entry ของ hook และ bridge ใน `trails/<id>.jsonl` ไปด้วย (ข้อ 2 ใน §10)
- **Rotate:** ตอนนี้ Claude Code ไม่ได้หมุนไฟล์ เพราะไฟล์ใหญ่สุด 20 MB ยังเป็นไฟล์เดียว ข้อนี้เป็นสมมติฐาน (A2)

### 4.6 อ่านย้อนตอน bridge กลับมาหลังปิดไป

ไม่ต้องมีกลไกพิเศษ ตอน `start` session ที่ `cursorOf(id)` มีค่าและ `size > cursor.off` จะถูก tail ต่อจาก cursor ทำให้ trail ฝั่ง transcript เติมช่วงที่หายไปได้ครบ (store §6.3 ขั้น 5)

session ที่ยังไม่เคย build จะได้แค่ `meta` ใหม่ และยังไม่ถูก build จนกว่าจะเข้าเงื่อนไขใน §3.1 ส่วน event ที่มีแค่ฝั่ง hook จะหายไปในช่วงที่ bridge ปิด ซึ่งเป็นข้อจำกัดที่ยอมรับแล้ว (store §6.3)

---

## 5. Redaction

transcript มีเนื้อหาเต็มทุกอย่าง ทั้ง prompt ที่อาจมี secret วางมา ผลลัพธ์ของ tool เนื้อหาไฟล์ และรูปภาพ indexer จึงมีความเสี่ยงสูงกว่า hook ที่ได้แค่ข้อมูลสรุป

- **ใช้ helper ตัวเดิม:** `redact`, `clip`, `summarizeTool` ([bridge/server.mjs:83-122](../../bridge/server.mjs)) ย้ายไปไว้ที่ `bridge/redact.mjs` (decision 11) แล้วให้ทั้ง server และ indexer import จากที่เดียว
- **ส่งออกเฉพาะ field ที่ผ่านฟังก์ชันพวกนี้แล้ว:** `parseLine` ไม่ส่ง `obj` หรือ `input` ดิบออกไปเลย และ entry มีแค่ field ตามข้อ 2.5
- **ขนาดข้อความ:** `prompt` ตัดที่ 120 ตัวอักษร (decision 8) ข้อความ error ของ `tool_result` ตัดที่ 120 และใช้แค่บรรทัดแรก
- **Path ของไฟล์:** ใช้แค่ `basename` ตามที่ `summarizeTool` ทำอยู่แล้ว
- **สิ่งที่ห้ามแตะ:** `thinking`, `text` ของ assistant (decision 6), `toolUseResult`, `attachment.*`, `api-request-blob`, `file-history-*` และเนื้อหารูปภาพ ไม่อ่านเลยนอกจากใช้เป็นเงื่อนไขข้าม
- **ไม่เปิดเผย path ใน home folder:** `meta.transcript` (path เต็ม) ส่งให้ store เท่านั้น store ไม่ส่งออก API (store §2.2)
- **ตรวจด้วย test:** ใส่ secret ปลอมทุก pattern ใน `SECRET_PATTERNS` ลงใน fixture แล้วยืนยันว่า entry ที่ออกมาไม่มี secret ตัวไหนหลุด

---

## 6. Interface ของโมดูล (ตาม store §7 และ decision 5)

```js
export function createIndexer({ root, redactor, log }) → EventEmitter & {
  start({ cursorOf, scanOf }): void,   // scanOf: ข้อเสนอเพิ่มเติม ดู §10 ข้อ 1
  build(sessionId): Promise<void>,      // lazy build ทั้งไฟล์ แล้วส่ง 'entries' ตามปกติ
  track(sessionId, transcriptPath): void,
  stats(): { files, built, badLines, unknownTypes, oversizeLines, versionMax, watcher: 'ok'|'polling' },
  stop(): Promise<void>,
}

on('meta',    rec)                         // { id, transcript, title, titleSrc, cwd, gitBranch, model,
                                           //   firstAt, lastAt, mtime, prompts, forkedFrom, scan }
on('entries', (id, entries, cursor))       // คืน Promise ได้ และ indexer จะรอก่อนส่งชุดถัดไปของ session นั้น
on('reset',   id)                          // ไฟล์ถูกตัดหรือถูกแทนที่ → store ส่ง SSE trail-reset
on('gone',    id)
on('health',  { healthy, reason? })        // ป้อนจาก stats():
                                           //   watcher เสีย → healthy:false, 'watcher'
                                           //   self-check ไม่ผ่าน (§8) → healthy:false, 'format-changed'
                                           //   version นอก TESTED_RANGE → healthy:true, 'untested-version'
```

- **ไม่มี exception หลุดออกนอกโมดูล:** ทุก error ในเส้นทางของ indexer ถูกจับไว้แล้วส่งออกเป็น `health` เท่านั้น เพื่อไม่ให้ bridge ล่มตาม
- **`entries` ไม่ส่ง `src` ที่ไม่ใช่ `'transcript'`:** และไม่ส่ง kind นอกเหนือจาก 5 ตัวใน decision 3

---

## 7. สมมติฐาน (ต้องยืนยันตอนทำจริง)

| # | สมมติฐาน | ถ้าผิดจะเป็นอย่างไร |
|---|---|---|
| A1 | ไฟล์ถูกเขียนต่อท้ายอย่างเดียว ไม่แก้บรรทัดเดิม | `headHash` จับได้เฉพาะช่วงหัวไฟล์ ถ้ามีการแก้กลางไฟล์จะไม่รู้ (ตรวจได้ด้วยการเทียบ hash ของ 4 KB ก่อน `cursor.off` ทุกครั้งที่ tail) |
| A2 | ไม่มีการหมุนไฟล์ ไฟล์เดียวต่อ session | ถ้าเกิดขึ้น ข้อ 4.5 จะ reset แล้ว build ใหม่ ไม่เสียข้อมูลแต่เปลือง |
| A3 | `custom-title` คือชื่อเดียวกับที่ sidebar แสดง | เทียบแล้ว 1 session ตรงกัน ("Claude agent office repository") ยังไม่ได้เทียบครบทุกตัว |
| A4 | `tool_use.id` ในไฟล์เท่ากับ `tool_use_id` ใน hook | ตาม decision 3 ไม่ได้ใช้ค่านี้ dedupe แล้ว ถ้าผิดกระทบแค่การ debug (store §10 ข้อ 2) |
| A5 | ชื่อไฟล์ `<id>.jsonl` = `session_id` ของ hook | ถ้าผิด `track()` และการผูก trail กับ session live จะพัง (store §10 ข้อ 1) |
| A6 | session จาก CLI ก็ใช้ format เดียวกัน | ข้อมูลที่พบทั้งหมดเป็น `claude-desktop` เพราะบนเครื่องนี้ยังไม่มี session จาก CLI ให้เทียบ |

---

## 8. ความเสี่ยงเมื่อ format เปลี่ยน

| ถ้า Claude Code เปลี่ยน… | ผลกระทบ | สิ่งที่ยังทำงานได้ |
|---|---|---|
| เพิ่ม type ใหม่ | ไม่มี ระบบข้ามและนับไว้ | ทุกอย่าง |
| เปลี่ยนชื่อหรือรูปแบบ `custom-title` | History แสดงชื่อ fallback จาก prompt แรก | trail และสถานะ live |
| ย้าย `tool_use` / `tool_result` ไปโครงสร้างอื่น | trail ขาด entry ประเภท tool | prompt และ trail ฝั่ง hook/bridge |
| เริ่มใส่ข้อความที่ hook ฉีดเข้ามาเป็น `user` prompt ปกติ | timeline มี "prompt" ปลอมซ้ำกับ entry `dispatch` ของ bridge | ทุกอย่างอื่น แก้ด้วยกฎข้ามเพิ่มใน §2.1 ข้อ 4 |
| เปลี่ยนที่เก็บไฟล์ หรือเลิกใช้ JSONL | indexer ใช้ไม่ได้ทั้งตัว และ `stats.files = 0` | office กลับไปทำงานแบบ hook อย่างเดียวเหมือนวันนี้ |
| เข้ารหัสหรือบีบอัด transcript | เหมือนบรรทัดบน | เหมือนบรรทัดบน |
| subagent กลับมาอยู่ในไฟล์หลัก | กฎ `isSidechain` ข้อ 2.1 กันไว้แล้ว | ทุกอย่าง |

ควรมี self-check ตอน start ด้วย: ถ้าไฟล์ที่ build แล้วได้ entry 0 ตัวเกินครึ่งของไฟล์ที่ใหญ่กว่า 100 KB ให้ส่ง `health { healthy: false, reason: 'format-changed' }` เพื่อให้ UI ขึ้นเตือน

---

## 9. Trade-off ที่เลือก

| ตัดสินใจ | ข้อดี | ข้อแลก |
|---|---|---|
| index จากหัว+ท้ายไฟล์ แล้วค่อย build ทีหลัง | start เร็ว (~100 ms เทียบกับ 4.9 s) | trail ของ session เก่าเปิดครั้งแรกช้าได้ถึง ~400 ms และ `prompts` ยังไม่รู้จนกว่าจะ build |
| cursor อยู่ในไฟล์ trail (decision 1) | entry กับ offset อยู่หรือหายพร้อมกัน ไม่ต้องมีไฟล์ของ indexer เอง | ต้องพึ่ง store ทั้งเรื่อง `cursorOf` และ `scan` |
| ไม่ patch entry (decision 2) | append ล้วน การแบ่งหน้าตรงไปตรงมา | tool ที่ล้มเหลวมี 2 entry และ subagent ไม่มีสถานะ "จบแล้ว" ใน trail |
| 5 kind เท่านั้น (decision 3) | ไม่ต้องมีโค้ด dedupe ข้ามแหล่ง | session ย้อนหลังไม่มี env, mode หรือ compaction ใน trail |
| ไม่ parse ไฟล์ subagent | ประหยัดการอ่าน 487 MB | ดูขั้นตอนข้างใน subagent ไม่ได้ (decision 7) |
| async chunk + yield แทน worker | ไม่เพิ่ม thread และโค้ดเรียบ | ต้องจูนขนาด chunk ให้ hook ยังตอบทัน |
| watcher + poll 30 s | ทนต่อ event ที่หล่นบน Windows | ช้าสุด 30 s ในกรณีที่ watcher เสีย |
| ข้ามบรรทัดของ fork | timeline ไม่ซ้ำกับ parent | UI ต้องโยงไปหา parent เองถ้าอยากแสดง (decision 10: ยังไม่ทำ) |

---

## 10. สิ่งที่ต้องตกลงกับ store เพิ่มเติม

ไม่มีคำถามค้างสำหรับพี่เอิร์ธแล้ว เหลือแค่สองจุดที่ต้องแก้ใน store §7 / §2.4 ให้ตรงกับเอกสารนี้

1. **`scanOf(id)`:** decision 1 ให้ `scan` อยู่ใน `index.json` ซึ่ง store เป็นคนเขียน ดังนั้น store ต้องส่ง `scan` กลับมาให้ indexer ตอน `start` ด้วย ไม่อย่างนั้น fast path ใน §3.3 ใช้ไม่ได้ และทุก restart จะต้องอ่านหัวกับท้ายไฟล์ใหม่ (~108 ms) ซึ่งช้าลงแต่ยังถูกต้อง
2. **พฤติกรรมตอน `reset`:** store ต้องล้างเฉพาะ entry ที่ `src: 'transcript'` และ cursor ของ session นั้น โดยคง entry ของ `hook`, `bridge` และ `legacy` ไว้ แล้วจึงส่ง SSE `trail-reset`
