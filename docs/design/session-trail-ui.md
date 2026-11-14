# Session Trail: History panel และ Timeline (UI design)

> สถานะ: ออกแบบเสร็จ พี่เอิร์ธอนุมัติแล้ว (ดู §11) ยังไม่มีโค้ด · ขอบเขต: ฝั่ง `web/` เท่านั้น
> เอกสารคู่กัน: `session-trail-indexer.md` (อ่าน transcript) และ `session-trail-store-api.md` (store, API, SSE · **contract ยึดตาม §5 ของไฟล์นั้น**)

## 1. เป้าหมาย

- ให้เห็น **ทุก session บนเครื่อง** รวมที่ปิดไปแล้ว ในรายการแบบ sidebar ของ Claude ที่แบ่งกลุ่มตามวันและค้นหาได้
- ให้แต่ละ session มี **Timeline** ที่ย้อนดูได้จนถึงต้น session และมีรายการใหม่ไหลเข้ามาแบบ realtime โดยไม่ทำให้ตำแหน่ง scroll กระโดด
- ฉาก 3D ต้องลื่นเท่าเดิม และ session ย้อนหลังห้ามแย่งโต๊ะ

## 2. สิ่งที่มีอยู่ตอนนี้ (อ้างอิงโค้ดจริง)

| เรื่อง | ตอนนี้ | ผลต่อดีไซน์ |
|---|---|---|
| Layout | `index.html`: `#left` "Current sessions" (`--left-w: 300px`), `#right` detail (`--right-w: 340px`), `#dock` ด้านล่าง, `#workspace` overlay | History อยู่ใน `#left` ส่วน Timeline อยู่ใน `#right` |
| ที่เก็บ state | `state.sessions: Map` ทุกตัวถูกส่งเข้า `office.update()` ([app.js:443](../../web/app.js)) | **ห้ามใส่ session ที่ presence เป็น `history` ลง `state.sessions`** เพราะ `update()` จะจัดโต๊ะให้ทุกตัวในนั้น ([scene.js:2106](../../web/scene.js)) |
| Trail | tab "Env trail" ใน detail สร้างจาก `s.trail` (สูงสุด 200) ด้วย `setHTML` ทั้งก้อนในทุก `renderAll()` ([app.js:263](../../web/app.js)) | แบบเดิมรองรับเป็นพันรายการไม่ได้ ต้องเปลี่ยนเป็นอัปเดต DOM ทีละส่วน และ session object จะไม่มี `trail` แล้ว |
| SSE `removed` | ลบ session ออกจาก map และล้าง `selectedId` ([app.js:641](../../web/app.js)) | ความหมายเปลี่ยนเป็น "ออกจากออฟฟิศ" (ดู §4.6) จึง **ห้ามล้าง selection** |
| Focus | `office.focus(id)` จะเงียบไปเฉยๆ ถ้า session ไม่มีโต๊ะ ([scene.js:2148](../../web/scene.js)) | เลือก session ย้อนหลังได้โดยไม่ต้องแก้ scene |
| จอแคบ | ที่ ≤860px panel ข้างกลายเป็น overlay สลับด้วย `body.show-left` / `show-right` | ใช้กลไกเดิมต่อได้เลย |
| สี | `--st-*` และ `.kind.*` ([styles.css:252](../../web/styles.css)) มีแค่ error/permission/dispatch/env | ต้องเพิ่ม kind ใหม่และแก้ contrast (ดู §7) |

## 3. Layout

### 3.1 Desktop (>1100px)

หัวกลุ่มวันที่ในภาพเป็นตัวอย่างตอน browser ใช้ locale ไทย (ดู §4.3)

```
┌ topbar ─────────────────────────────────────────────────────────────────────────┐
│ ♥ Agent Office  [2 sessions][1 working]…          5h ▮▮▯ 7d ▮▯▯   ● Live  ☀ 10:00 │
└─────────────────────────────────────────────────────────────────────────────────┘
┌ #left (300) ──────────┐                                   ┌ #right (340) ─────────┐
│ [ Office ] [History]  │                                   │ claude-agent-office ✕ │
│ ───────────────────── │                                   │ ● Working · Opus 5.5  │
│ 🔍 Search sessions…   │                                   │ main · E:\…\office    │
│ ─ วันนี้ ─────────────│          ฉาก 3D (เหมือนเดิม)          │ [Progress][Background]│
│ ● ดึง Commit ล่าสุด    │                                   │ [Timeline][Status]    │
│   claude-agent… · now │                                   │ ───────────────────── │
│ ○ Design: Indexer     │                                   │ [All][Prompts][Tools]…│
│   claude-agent… · 3m  │                                   │ ▲ 3 new               │
│ ─ เมื่อวาน ────────────│                                   │ 10:42 ⌘ Edit app.js ✕ │
│ ✓ 3D AI Agent office… │                                   │ 10:41 ⌘ Read scene.js │
│   claude-agent… · 1d  │                                   │ 10:40 › Prompt: แบ่ง… │
│ ─ 8 พ.ย. ─────────────│                                   │ ── 13 พ.ย. ────────── │
│   งานวิจัย Software…    │                                   │ 18:02 ⚠ Bash failed…  │
│   research · 6d       │                                   │ …                     │
│ ─ ต.ค. 2569 ──────────│                                   │ ⟳ Loading older…      │
│   …                   │                                   └───────────────────────┘
└───────────────────────┘
┌ #dock (Ask Input · Minju's Desk · Live feed · Grok Bots) ─────────────────────────┐
```

### 3.2 จอแคบ (≤860px)

```
┌ ☰  Agent Office      ● Live   ⓘ ┐      กด ☰ → #left เป็น overlay (tab Office/History)
│                                 │      กดรายการ → ปิด #left แล้วเปิด #right
│        ฉาก 3D                   │      (ใช้ show-left/show-right แบบเดิม)
│                                 │
├─────────────────────────────────┤      แตะได้อย่างน้อย 44px ต่อแถว
│ ┌ #right overlay ─────────────┐ │      แถบ filter เลื่อนแนวนอนได้
│ │ ← title           ✕         │ │
│ │ [Timeline][Status]          │ │
│ │ 10:42 ⌘ Edit app.js         │ │
└─┴─────────────────────────────┴─┘
```

## 4. History panel

### 4.1 วางตรงไหน

ใส่ tab ใน `#left` ชื่อ **Office** และ **History** (ตัดสินแล้ว: D1)

- **Office:** การ์ดแบบเดิม แสดงทุกตัวใน `state.sessions` คือ presence `live`, `idle` และ `ended` ช่วง 15 นาทีที่ยังมีโต๊ะ
  - ถ้า server ส่ง `desk: false` (โต๊ะเต็มทั้ง 42 ตัว) การ์ดยังแสดงตามปกติ และหัว panel ขึ้น "+N without a desk"
- **History:** รายการใหม่ แสดงทุก record จาก index รวมตัวที่ยัง live อยู่ด้วย เพื่อให้หา session ได้จากที่เดียว
- เหตุผล: การ์ด Office มีข้อมูลเยอะ (progress, chips, subagents) ส่วน History ต้องกะทัดรัดเพราะมีเป็นร้อยแถว
- tab ที่เลือกจำไว้ใน `localStorage` (`office-left-tab`) ครอบด้วย try/catch แบบเดียวกับ setting อื่น

### 4.2 แถวของ History

```
┌──────────────────────────────────────┐
│ ●  Claude agent office repository  3m│  ← indicator · title · เวลาล่าสุด (lastAt)
│    claude-agent-office · main        │  ← project · gitBranch (สีเทา)
└──────────────────────────────────────┘
```

- **Title:** ใช้ `title` ถ้าไม่มีใช้ `project` แล้วตัดด้วย ellipsis โดยวาง title เต็มไว้ใน `title=` attribute
- **Indicator:** ตาม `presence` และต้องใช้ **รูปทรงคู่กับคำ ไม่ใช่สีอย่างเดียว**

| `presence` | สัญลักษณ์ | สี | ข้อความสำหรับ screen reader |
|---|---|---|---|
| `live` | ● ทึบ (pulse ถ้า `status` เป็น working/waiting) | `--st-<status>` | "Live, Working" |
| `idle` | ○ วงกลวง | `--st-idle` | "Open, idle" |
| `ended` | ✓ | `--st-ended` | "Ended" |
| `history` | ไม่มีสัญลักษณ์ (เว้นที่ไว้ให้แถวตรงกัน) | — | "History" |

- **Waiting:** record ที่ `waiting: true` จะขึ้น badge `!` สี `--st-waiting` เหมือนการ์ด Office

### 4.3 การจัดกลุ่ม (ตาม locale ของ browser: D3)

- จัดกลุ่มด้วย `lastAt` ตาม timezone ของ browser
- ภาษาของหัวกลุ่มมาจาก `Intl` ทั้งหมด ไม่ hard-code คำ:

| กลุ่ม | วิธีได้ข้อความ | th-TH | en-US |
|---|---|---|---|
| วันนี้ / เมื่อวาน | `new Intl.RelativeTimeFormat(undefined, {numeric:'auto'}).format(0 \| -1, 'day')` (ตัวอักษรแรกเป็นตัวใหญ่) | วันนี้ · เมื่อวาน | Today · Yesterday |
| ภายใน 7 วัน | `Intl.DateTimeFormat(undefined, {day:'numeric', month:'short'})` | 8 พ.ย. | Nov 8 |
| เก่ากว่านั้น | หัวรายเดือน `Intl.DateTimeFormat(undefined, {month:'short', year:'numeric'})` | ต.ค. 2569 | Oct 2026 |

  - ใช้หัวรายเดือนแทนคำว่า "Older" เพราะ `Intl` ไม่มีคำนี้ให้ และหัวรายเดือนยังช่วยไล่หา session เก่าได้ดีกว่า
- หัวกลุ่มเป็น `<h3>` ที่ติดบนสุดตอน scroll (`position: sticky`)
- เรียงตาม `lastAt` ใหม่ไปเก่า (server เรียงมาให้แล้ว) ต่างจาก Office ที่เรียงตาม `startedAt`
- **กันรายการกระโดด:** ถ้าผู้ใช้กำลัง hover หรือ focus อยู่ในลิสต์ ให้พักการย้ายแถวที่ `lastAt` เปลี่ยน แล้วค่อยเรียงใหม่ตอนเมาส์ออกหรือ focus หลุด ส่วนข้อมูลในแถวยังอัปเดตตามปกติ

### 4.4 ค้นหา

- `<input type="search" aria-label="Search sessions">` อยู่บนสุดของ tab และ debounce 150ms
- **ค้นที่ client** เมื่อโหลดครบแล้ว (`next === null`, ตอนนี้ 123 record) จับคู่ใน `title`, `project`, `cwd`, `gitBranch` โดย normalize ด้วย `normalize('NFC').toLocaleLowerCase()` เหมือนฝั่ง server
- ถ้ายังโหลดไม่ครบ: ส่ง `q` ไปที่ `POST /api/sessions/list` แล้วแสดงผลแยก โดยไม่ทับลิสต์หลักที่ cache ไว้
- ไม่เจอ: แสดง "No sessions match "…"" พร้อมปุ่ม Clear
- `/` โฟกัสช่องค้นหาเมื่อ tab History เปิดอยู่ และ Esc ในช่องค้นหาจะล้างข้อความก่อน กดอีกครั้งถึงค่อยออก

### 4.5 คลิกแล้วเกิดอะไร

| กรณี | กล้อง 3D | `#right` | Assign target |
|---|---|---|---|
| อยู่ใน `state.sessions` และมีโต๊ะ (`live`, `idle`, `ended` ช่วง 15 นาที) | `office.focus(id)` บินไปที่โต๊ะเหมือนเดิม | detail เต็ม และเปิด tab **Timeline** | ตั้งเป็น session นี้ถ้า `isActive` |
| อยู่ใน `state.sessions` แต่ `desk: false` | ไม่ขยับ | detail เต็ม | ตั้งเป็น session นี้ |
| `history` (ไม่อยู่ใน `state.sessions`) | **ไม่ขยับ** (ไม่เรียก `overview()` ด้วย ผู้ใช้จะได้ไม่เสียมุมกล้อง) | detail แบบ **Archive** (ดู §6) | ไม่เปลี่ยน |

- คลิกการ์ดใน tab Office ยังเปิด tab ที่ผู้ใช้ดูอยู่ล่าสุดเหมือนเดิม จะเปิด Timeline อัตโนมัติก็เฉพาะตอนเลือกจาก History
- คลิกโต๊ะในฉาก 3D ทำงานเหมือนเดิม

### 4.6 การโหลดและการอัปเดต

- เปิด tab History ครั้งแรกถึงค่อยเรียก `POST /api/sessions/list` (`{limit: 200}`) ไม่โหลดตอน start dashboard
- ถ้ามี `next` ให้โหลดหน้าถัดไป (`{cursor: next}`) เมื่อ scroll ถึงปลายลิสต์ (ใช้ `IntersectionObserver` กับ sentinel)
- **SSE `index`**
  - `{op:'upsert', record}` → `state.history.set(record.id, record)`
  - `{op:'remove', id}` → ลบออกจาก `state.history` ถ้าเป็นตัวที่เลือกอยู่ ให้ Timeline แสดง "no longer available" (§5.6)
- **SSE `removed` (ความหมายใหม่: presence → `history`)**
  - ลบออกจาก `state.sessions` เท่านั้น เพื่อให้ avatar เดินออกและโต๊ะว่าง
  - **ไม่ล้าง `selectedId`** ถ้าเลือกอยู่ detail จะสลับเป็นโหมด Archive เอง โดยเก็บ Timeline และตำแหน่ง scroll ไว้
  - record ฝั่ง History มาถึงทาง `index upsert`
- **ต่อ SSE ใหม่:** ถ้า tab History เคยโหลดแล้ว ให้ refetch หน้าแรกแล้ว merge ตาม `id`

## 5. Timeline

### 5.1 ที่อยู่

- **แทน tab "Env trail"** ใน detail ด้วย tab **Timeline** ที่รวม kind ทุกแบบ (ตัดสินแล้ว: D5)
- ปุ่ม ⤢ ขยายเต็ม overlay **ไม่อยู่ใน phase 1** (D2)

### 5.2 ลำดับและ scroll

- **จาก server:** `POST /api/sessions/trail` ส่ง page ที่เรียง **เก่าไปใหม่ภายใน page** มาให้ และ `before` เป็น byte offset แบบ opaque
- **ฝั่ง client:**
  - เก็บทุก entry ที่โหลดแล้วใน `Map` ตาม `id` (dedupe)
  - แสดงแบบ **ใหม่อยู่บน** โดย sort ตาม `t` ภายในช่วงที่โหลดมาแล้ว (ถ้า `t` เท่ากันใช้ลำดับที่ได้มา) เพราะลำดับในไฟล์อาจไม่ตรงเวลาหลัง bridge ดับ
  - ส่วนที่เพี้ยนข้ามหน้ายอมรับได้ตามที่ store-api ตกลงไว้
- **ของเก่า** (page ถัดไปด้วย `before`) ต่อท้ายด้านล่าง → การ append ไม่ขยับ `scrollTop`
- **ของใหม่จาก SSE `trail`**
  - ถ้า `t` ใหม่กว่าแถวบนสุด:
    - ถ้า `scrollTop < 24px` (อยู่บนสุด) แทรกทันที
    - ถ้าเลื่อนลงไปแล้ว **ไม่แทรก** ให้เก็บใน buffer แล้วแสดง pill **"▲ N new"** แบบ sticky กดแล้วค่อยแทรกและเลื่อนขึ้นบน
  - ถ้า `t` อยู่ในช่วงที่โหลดแล้ว (มาช้า เช่น ตอนไล่ transcript หลัง restart) ให้แทรกตามตำแหน่งที่ sort และชดเชย `scrollTop += (scrollHeight หลัง − ก่อน)` ถ้าแทรกเหนือจุดที่มองอยู่
  - ถ้า `t` เก่ากว่าแถวล่างสุดและยังมีหน้าเก่าเหลือ ให้ทิ้งไป เพราะจะมาเองตอนโหลดหน้าเก่า
- คั่นวัน: แถว separator `── 13 พ.ย. ──` (format เดียวกับ §4.3) เมื่อวันของรายการเปลี่ยน
- แถว **prompt** เด่นกว่าแถวอื่น (ตัวหนา มีเส้นซ้ายสี `--accent`) เพื่อแบ่ง turn ด้วยตา โดยไม่ต้องทำ group ที่พับได้

### 5.3 แถวตาม kind

```
10:42  ⌘  Edit · scene.js                          ✕
│      │  └ text (บรรทัดเดียว, ellipsis, คลิกเพื่อขยาย 3 บรรทัด)
│      └ icon + label ของ kind (มีทั้งไอคอนและคำ)
└ เวลา HH:MM (tooltip เป็นวันเวลาเต็ม)
```

| kind | ไอคอน | สี accent | ข้อความ / หมายเหตุ |
|---|---|---|---|
| `prompt` | › | `--accent` | ข้อความที่ผู้ใช้พิมพ์ ตัดที่ 1 บรรทัด และเป็นแถวเด่น |
| `tool` | ⌘ | `--st-working` | `text` จาก store เช่น `Edit · scene.js` · ท้ายแถวขึ้น ✕ **เฉพาะเมื่อมี entry id `<id ของแถวนี้>:err` อยู่ในช่วงที่โหลดแล้ว** (ไม่มี field `ok` และไม่มี ✓) tooltip ของ ✕ คือ `text` ของ error entry และคลิก ✕ จะเลื่อนไปที่แถว error นั้น |
| `error` | ⚠ | `--st-error` | |
| `permission` | ? | `--st-waiting` | Allowed / Denied / Asked |
| `dispatch` | ↧ | `--accent` | งานที่ส่งจาก Minju's Desk |
| `subagent` | 👥 | `--st-thinking` | |
| `skill` | 🧩 | `--st-compacting` | |
| `env`, `mode` | ⚙ | `--st-idle` | cwd, model, effort, compaction, permission mode |
| `session` | ◆ | `--st-standby` | start / end / resume |
| `background`, `notify`, `git`, `other` | • | `--muted` | ใช้ label ตาม kind |

- `text` ใส่ผ่าน `textContent` เสมอ ไม่ใช้ `innerHTML` เพราะเป็นข้อความจาก transcript ที่ผ่าน redaction แล้วก็จริง แต่ก็ยังเป็นข้อมูลภายนอกอยู่ดี
- ข้อจำกัดของ ✕: ถ้า error entry อยู่คนละหน้ากับ tool (เช่น tool อยู่ล่างสุดของหน้า) ✕ จะขึ้นเมื่อโหลดหน้าที่มี error มาแล้ว ยอมรับได้

### 5.4 Filter (กรองฝั่ง server ด้วย `kinds`)

- เป็นกลุ่มปุ่ม **เลือกได้ทีละอัน** (`role="radiogroup"`) แต่ละปุ่ม map ไปเป็น `kinds`:

| ปุ่ม | `kinds` ที่ส่ง |
|---|---|
| All | (ไม่ส่ง) |
| Prompts | `["prompt"]` |
| Tools | `["tool", "error"]` (ต้องมี error ด้วย ไม่งั้น ✕ จะไม่ขึ้น) |
| Errors | `["error"]` |
| Permissions | `["permission"]` |
| Env | `["env", "mode", "session"]` |
| More ▾ | `subagent`, `skill`, `dispatch`, `background`, `notify`, `git`, `other` ทีละตัว |

- **เปลี่ยน filter:** ล้างรายการแล้วเรียกหน้าแรกใหม่พร้อม `kinds` (`before: null`)
- SSE `trail` ที่เข้ามาให้กรองที่ client ด้วยชุด `kinds` เดียวกัน
- จำ filter ไว้ต่อ browser แต่ไม่จำต่อ session
- **Env ว่างเป็นเรื่องปกติ** สำหรับ session ย้อนหลังที่ออฟฟิศไม่เคยเห็นตอน live (D7) ให้แสดง empty state ของตัวเอง (§5.6)

### 5.5 รายการยาว: ไม่ทำ virtual scroller

ไม่เขียน virtual scroller เอง แต่ใช้:

1. `content-visibility: auto; contain-intrinsic-size: auto 36px;` ต่อแถว ให้ browser ข้าม layout/paint ของแถวที่อยู่นอกจอ
2. โหลดทีละหน้า 200 รายการ (`before` cursor) เมื่อ sentinel ด้านล่างเข้าจอ
3. **เก็บ DOM ไม่เกิน 1,000 แถว** ถ้าเกินและผู้ใช้อยู่ลึกด้านล่าง ให้ตัดแถวบนสุด (ของใหม่) ทิ้งแล้วแสดง "▲ Jump to latest" ซึ่งจะโหลดหน้าแรกใหม่

- เหตุผล: แถวสูงไม่เท่ากัน (ขยาย 3 บรรทัดได้, separator, prompt) ทำให้ virtual scroller ต้องวัดความสูงเองและแก้ยาก ส่วน `content-visibility` ได้ผลด้าน performance ส่วนใหญ่ด้วยโค้ดแค่ไม่กี่บรรทัด
- ถ้าวัดแล้วไม่ผ่าน budget ใน §7.2 ค่อยเปลี่ยนเป็นแถวสูงคงที่บวก windowing

### 5.6 สถานะต่างๆ

| สถานะ | สิ่งที่บอกว่าอยู่สถานะนี้ | แสดง |
|---|---|---|
| Loading หน้าแรก | รอ response | skeleton 6 แถว (`aria-busy="true"` บน list) |
| Building | response `building: true` | "Building the timeline from the transcript…" รอ SSE `trail-ready` แล้วเรียกหน้าแรกใหม่ ถ้าเกิน 30 วินาทีแสดงปุ่ม Retry |
| Loading หน้าเก่า | รอ page ถัดไป | แถว "⟳ Loading older…" ท้ายลิสต์ |
| ถึงต้น session | `before === null` | "Start of session · 13 พ.ย. 18:00" |
| Empty (All) | หน้าแรกว่างและ `before === null` | "No activity recorded yet." |
| Empty (Env) | filter Env ว่าง | "No environment changes recorded. The office only records these for sessions it saw live." |
| Empty (filter อื่น) | filter ว่าง | "Nothing matches this filter." พร้อมปุ่ม Show all |
| Error | network หรือ 5xx | "Couldn't load the timeline." พร้อมปุ่ม **Retry** และเก็บรายการที่โหลดไว้แล้วให้แสดงต่อ |
| Session no longer available | `404` หรือ SSE `index {op:'remove'}` ของ session ที่เลือก | "This session is no longer available. Claude Code has removed its transcript." และซ่อน filter |
| SSE หลุด | `#conn` เดิม | พอต่อได้ให้ refetch หน้าแรกแล้ว merge ด้วย `id` |
| Trail ถูกสร้างใหม่ | SSE `trail-reset` | ล้างแล้วโหลดหน้าแรกใหม่ โดยรักษา filter เดิมไว้ |

## 6. Detail แบบ Archive (presence `history`)

```
┌ #right ──────────────────────────────┐
│ งานวิจัย Software Engineer…        ✕ │
│ History · 8 พ.ย. 14:02 – 16:40       │
│ research · main · Opus 5.5           │
│ E:\…\research                        │
│ [⧉ Copy resume command]              │
│ [Timeline] [Status]                  │
│ ──────────────────────────────────── │
│ …timeline…                           │
└──────────────────────────────────────┘
```

- **ช่วงเวลา:** `firstAt` ถึง `endedAt` (ถ้าไม่มีใช้ `lastAt`)
- **Tab:** มีเฉพาะ Timeline และ Status ส่วน Progress และ Background ซ่อน เพราะเป็นข้อมูล live
- **Status:** แสดงข้อมูลจาก record คือ `cwd`, `gitBranch`, `model`, `counts` (prompts/tools/errors), `firstAt`, `lastAt`, `endedAt`
- **Action มีแค่ "Copy resume command"** (D4) ที่คัดลอก `claude --resume <id>`
  - ใช้ `navigator.clipboard.writeText` ซึ่งใช้ได้เพราะ `127.0.0.1` นับเป็น secure context แล้วแสดง toast "Copied. Run it in <project>"
  - ถ้า clipboard ใช้ไม่ได้ ให้แสดงคำสั่งในช่อง `<input readonly>` ที่เลือกข้อความไว้ให้
  - ไม่ใส่ `cd "<cwd>"` ในคำสั่ง เพราะไม่รู้ว่าผู้ใช้ใช้ shell อะไร (PowerShell, bash, cmd quote ต่างกัน) ให้โชว์ `cwd` ไว้ข้างๆ แทน
- **ไม่มี:** Workspace 🗂, Forget, Standby และ Assign
- **ถ้า session กลับมา live:** เช่น resume แล้ว hook ยิง SSE `session` ส่ง session กลับเข้า `state.sessions` → detail สลับเป็นโหมดปกติเองโดยคงตำแหน่ง Timeline ไว้ และ `office.update()` จะจัดโต๊ะให้ตามกลไกเดิม

### State ฝั่ง client

```js
state.sessions   // Map เดิม: presence live/idle/ended จาก snapshot + session → ส่งเข้า office.update()
state.history    // Map ใหม่: record จาก /api/sessions/list + index → ไม่ส่งเข้า scene
state.selectedId // id เดียว: renderDetail หาใน sessions ก่อน แล้วค่อยหาใน history
state.timeline   // { id, kinds, byId: Map, order: [], before, building, loading, error, gone, pendingNew: [] }
                 // มีแค่ของ session ที่เลือก
```

- เมื่อเลือก session อื่น ให้ทิ้ง `state.timeline` ตัวเก่า (ไม่ cache ทุก session เพื่อคุม memory)

## 7. Accessibility และ Performance

### 7.1 Accessibility

**Keyboard**
- Tab Office/History ใช้ `role="tab"` พร้อม `aria-selected`, `aria-controls` และลูกศรซ้ายขวาเปลี่ยน tab
- แถว History เป็น `<button>` ใน `<ul>` และใช้ลูกศรขึ้นลงเลื่อน focus ได้ (roving tabindex)
- Filter เป็น `radiogroup` และใช้ลูกศรเลือกได้
- Timeline ใช้ ARIA `feed` pattern: `role="feed"`, แต่ละแถวเป็น `role="article"` ที่ focus ได้, `aria-busy` ตอนโหลด, PageDown/PageUp เลื่อนทีละแถว

**Focus**
- เลือก session จาก History บนจอแคบ: ย้าย focus ไปที่หัว `#right` (`h3` ใส่ `tabindex="-1"`)
- กด ✕ หรือ Esc: คืน focus ไปที่แถวที่เลือกไว้
- `:focus-visible` ใช้ outline `--accent` 2px ตามแบบที่มีอยู่

**Live region**
- ไม่ announce ทุกรายการใหม่ ใช้ `#toast` (`aria-live="polite"`) ที่มีอยู่แล้ว ประกาศเฉพาะ "N new entries" เมื่อ pill ขึ้น

**Contrast** (คำนวณจาก token จริงบนพื้นขาว)
- `--st-waiting #D98A00` ≈ 2.8:1, `--st-working #1E93BD` ≈ 3.5:1 และ `--st-error #D63A57` ≈ 4.5:1 ฉะนั้นสองตัวแรก **ไม่ผ่าน AA** สำหรับตัวหนังสือ 10–11px ที่ `.kind` ใช้อยู่ตอนนี้
- **ข้อเสนอ:** ตัวหนังสือของ kind ใน Timeline ใช้ `--text` หรือ `--muted` (`#5F6678` ≈ 5.7:1) ส่วนสีของ kind ใช้แค่ที่ไอคอนและเส้นซ้าย (non-text ต้องการแค่ 3:1)
- ธีม dark: token เป็นโทนสว่างบนพื้นเข้ม ผ่านอยู่แล้ว

**Reduced motion**
- `prefers-reduced-motion` ปิด pulse ของ indicator และ smooth-scroll ของ "Jump to latest"

**ภาษา**
- `text` ที่เป็นภาษาไทยใช้ฟอนต์ `--font-ui` (IBM Plex Sans Thai) ที่โหลดไว้อยู่แล้ว
- label ของ UI ยังเป็นภาษาอังกฤษ ส่วนวันที่และหัวกลุ่มตาม locale (§4.3)

### 7.2 Performance budget (เทียบกับ render loop 3D)

ฉาก 3D ใช้ frame ส่วนใหญ่อยู่แล้ว งาน UI เลยต้องไม่เกิน **~2ms ต่อ frame** ตอนที่มี event เข้า

| งาน | Budget | วิธี |
|---|---|---|
| SSE `trail` ต่อ batch (server รวมทุก 250ms) | < 1ms | ใส่ DOM ทีละแถว (`insertBefore`) **ไม่ผ่าน** `setHTML` ทั้งก้อน รวม event ใน `requestAnimationFrame` เดียวกับ `renderAll` และทิ้ง batch ของ session ที่ไม่ได้เลือกทันที |
| Render History 200 แถว | < 4ms ครั้งแรก, < 1ms ตอนอัปเดต | reuse element ด้วย key แบบเดียวกับ `cardEls` ([app.js:192](../../web/app.js)) |
| Scroll Timeline | ไม่มี long task > 16ms | `content-visibility`, DOM ≤ 1,000 แถว, ไม่มี listener `scroll` ที่อ่าน layout (ใช้ `IntersectionObserver`) |
| Memory | ≤ 1 timeline ใน memory, index ≤ 2,000 record | ทิ้ง timeline ทุกครั้งที่เปลี่ยน session |
| Payload SSE `session` | ไม่มี `trail` แล้ว (store-api §5.3) | ไม่ต้องทำอะไรฝั่ง client นอกจากเลิกอ่าน `s.trail` |

- ตรวจด้วย `?stats` / `__officeStats()` ที่มีอยู่ บวก Performance panel ใน Chrome ขณะรัน `npm run mock` พร้อม timeline 5,000 รายการ

## 8. Contract ที่ UI ใช้ (สรุปจาก `session-trail-store-api.md` §5)

ทุก endpoint เป็น `POST` + `Content-Type: application/json` + header `X-Office-Token` ใช้ helper `api()` เดิมใน `app.js` ได้เลย

| เรียก | request | response ที่ UI ใช้ |
|---|---|---|
| `POST /api/sessions/list` | `{cursor, q, limit ≤ 200}` | `items[]` (`id`, `title`, `project`, `cwd`, `gitBranch`, `model`, `presence`, `status`, `waiting`, `firstAt`, `lastAt`, `endedAt`, `counts`), `next`, `total` |
| `POST /api/sessions/trail` | `{sessionId, before, limit ≤ 500, kinds?}` | `entries[]` (`id`, `t`, `kind`, `src`, `text`, `tool?`) เรียงเก่าไปใหม่ภายใน page · `before` (null = หมดแล้ว) · `building` · `404` = ไม่มี session นี้ |

**SSE ที่ UI ฟัง**

| `type` | การกระทำของ client |
|---|---|
| `snapshot` | `state.sessions` = presence ≠ history (ไม่มี `trail`) |
| `session` | upsert `state.sessions` (มี `presence`, `desk`, `title`) |
| `removed` | ออกจาก `state.sessions` เท่านั้น ไม่ล้าง selection (§4.6) |
| `index` | `{op:'upsert', record}` / `{op:'remove', id}` → `state.history` |
| `trail` | `{sessionId, entries}` → ถ้าเป็น session ที่เลือก ให้ merge (§5.2) ถ้าไม่ใช่ทิ้ง |
| `trail-ready` | ถ้าเป็น session ที่เลือกและอยู่ในสถานะ Building ให้เรียกหน้าแรกใหม่ |
| `trail-reset` | ถ้าเป็น session ที่เลือก ให้ล้างแล้วเรียกหน้าแรกใหม่ |

## 9. Trade-off ที่เลือก

| ทางเลือก | เลือก | เหตุผล | ราคาที่จ่าย |
|---|---|---|---|
| History เป็น tab ใน `#left` หรือรวมลิสต์เดียว | tab | การ์ด Office กับแถว History มีความหนาแน่นต่างกันมาก | ต้องกดสลับ tab ถึงจะเห็น session ย้อนหลัง |
| Newest-first หรือแบบแชท oldest-first | newest-first | append ของเก่าไม่ขยับ scroll และตรงกับ Env trail กับ Live feed ที่มีอยู่ | ต้อง reverse page ที่ได้จาก server และอ่านเรื่องราวจากล่างขึ้นบน |
| `content-visibility` + เพดาน DOM หรือ virtual scroller | content-visibility | โค้ดน้อยและแถวสูงไม่เท่ากันได้ | ถ้า session ยาวมากต้องกด "Jump to latest" |
| กรองที่ server (`kinds`) หรือ client | server | หา error เก่าเจอโดยไม่ต้องโหลดทั้ง session | เปลี่ยน filter ทุกครั้งต้องเรียก API ใหม่ |
| ✕ จาก entry `:err` หรือ field `ok` | `:err` | store ไม่ต้อง patch entry ย้อนหลัง | ✕ จะขึ้นเมื่อโหลด error entry มาแล้วเท่านั้น |
| ไม่ขยับกล้องเมื่อเลือก history | ไม่ขยับ | ไม่มีโต๊ะให้บินไป และไม่เสียมุมที่ผู้ใช้ตั้งไว้ | ต้องมีป้าย presence ใน detail บอกว่าไม่อยู่ในออฟฟิศ |
| Copy resume command แบบไม่มี `cd` | ไม่มี `cd` | ใช้ได้ทุก shell | ผู้ใช้ต้องเข้าโฟลเดอร์เอง (โชว์ `cwd` ไว้ให้) |

## 10. Assumptions

- `presence` มาจาก store เสมอ client ไม่คำนวณเอง
- session ที่จบแล้ว (`ended`) **ยังอยู่ใน `state.sessions` และนั่งโต๊ะต่อ 15 นาที** (`ENDED_DESK_MS`) แล้วจึงได้ SSE `removed` และย้ายไปอยู่ใน History อย่างเดียว
- `waiting` อยู่ใน list record และใน `index upsert` ด้วย
- ไม่ต้องรองรับ browser ที่ไม่มี `content-visibility` (ถ้าไม่มีก็แค่ช้ากว่า ไม่พัง)

## 11. Decisions (2026-11-14)

พี่เอิร์ธอนุมัติผ่าน session หลัก "ดึง Commit ล่าสุด":

| # | เรื่อง | ตัดสิน |
|---|---|---|
| D1 | ตำแหน่ง History | tab "Office \| History" ใน `#left` |
| D2 | ปุ่ม ⤢ ขยาย Timeline | ทำทีหลัง ไม่อยู่ใน phase 1 |
| D3 | ภาษาของหัวกลุ่มวันที่ | ตาม locale ของ browser (ไทยแสดง "วันนี้ / เมื่อวาน / 8 พ.ย.") |
| D4 | Action ของ session ย้อนหลัง | มีแค่ "Copy resume command" ไม่มี Workspace |
| D5 | Env trail เดิม | ยุบรวมเข้า Timeline |
| D6 | Session ที่จบแล้ว | นั่งโต๊ะต่อ 15 นาที (presence `ended`) แล้วย้ายไป History |
| D7 | Env/mode ของ session ย้อนหลัง | ไม่มีได้ (ยอมรับ) และ filter Env มี empty state ของตัวเอง |
| D8 | API | `POST /api/sessions/list` และ `POST /api/sessions/trail` ด้วย `X-Office-Token` ใช้ชื่อ field ของ store (`presence`, `gitBranch`, `firstAt`, `next`, `before`) |
| D9 | ลำดับใน trail page | page เรียงเก่าไปใหม่ client reverse และ sort ตาม `t` ภายในช่วงที่โหลดแล้ว · filter ใช้ `kinds` ฝั่ง server |
| D10 | SSE | `index` (`upsert`/`remove`), `trail`, `trail-ready`, `trail-reset` · `removed` = ออกจากออฟฟิศ ไม่ใช่ลบ |
| D11 | สถานะของ tool | ไม่มี `ok` แสดง ✕ เมื่อมี entry `<tool id>:err` ในช่วงที่โหลดแล้ว ไม่มี ✓ |
| D12 | Transcript ถูกลบ | store ลบ record และ API ตอบ `404` UI แสดง "session no longer available" |

## 12. Follow-up ที่เจอระหว่างทาง (ไม่อยู่ในงานนี้)

- tab ที่มีอยู่ (`.tabs [role=tab]`) ยังไม่มี `aria-selected` และยังใช้ลูกศรเปลี่ยน tab ไม่ได้
- `.kind.permission` และ `.kind.env` ใน Live feed มี contrast ต่ำกว่า AA ในธีม light
