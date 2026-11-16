# AGENT_IMPLEMENTATION_PLAN — Xem Tim Mỗi Ngày (Daily Learning Heart)

> Tài liệu thiết kế kiến trúc & phân công tác vụ cho đội ngũ Multi-Agent thực thi nâng cấp toàn diện hệ thống **Xem Tim Mỗi Ngày (Daily Learning Heart)** theo đúng đặc tả trong [expected_output.md](file:///Users/dinhduy/AI/daily_cardiology_ebm/expected_output.md) và hệ thống thiết kế Supabase trong [design.md](file:///Users/dinhduy/AI/daily_cardiology_ebm/design.md).

---

## 1. Tóm tắt Chuyển đổi Cốt lõi (Từ PubMed Crawler ➔ Guideline Evolution Platform)

| Hạng mục | Hệ thống Cũ | Hệ thống Mới (Mục tiêu) |
| :--- | :--- | :--- |
| **Nguồn & Bản chất Nội dung** | Crawl bài báo nghiên cứu ngẫu nhiên (3 bài mới nhất trên PubMed) | **Chỉ lấy Guidelines chính thức** (ESC, ACC/AHA, EACTS, ESC/ESH...) và tối đa 3 **Landmark RCTs** nền tảng tạo nên sự thay đổi của Guideline đó. |
| **Tiến trình (Pipeline Diagram)** | Hiển thị quy trình crawl (`STEP 1: CRAWL WINDOW` → `STEP 2: TIER-1 JOURNALS` → `STEP 3: VERBATIM STATS`) | Hiển thị **Tiến hóa Nội dung Guideline** qua các thế hệ: *Chỉ dẫn A trong Guideline thế hệ cũ (VD: ESC 2003/2018)* ➔ *Bằng chứng Landmark RCTs tháo gỡ rào cản* ➔ *Chỉ dẫn B trong Guideline hiện hành (VD: ESC 2024–2026)*. |
| **Chu trình Luân phiên Hàng ngày** | Mỗi lần cập nhật sáng đủ cả 10/10 trụ cột cùng một ngày | **Mỗi ngày CHỈ hiển thị 1 Trụ cột** theo số tiến (`1 → 2 → 3 → ... → 10 → 1`). VD: Hôm qua `2026-11-15` là Trụ cột #10, **Hôm nay `2026-11-16` là Trụ cột #1**, Ngày mai `2026-11-17` là Trụ cột #2. |
| **Xác thực Người dùng (Auth)** | Chưa có đăng nhập | Có **Cổng Đăng nhập / Đăng ký** & Hồ sơ cá nhân hóa (lưu bản tin đã đọc, đã lưu/bookmark, lịch sử phản hồi của chính tài khoản). |
| **Lịch sử & Sơ đồ Lịch sử** | Danh sách phẳng lẫn lộn 10 trụ cột | Có chế độ **Lịch sử Theo Trụ cột** (xem lại Trụ cột #1 của tuần cũ) kèm **Sơ đồ Tiến hóa Lịch sử giới hạn riêng cho từng Trụ cột** (VD: `Trụ cột #1 ngày 12/07` ➔ `Trụ cột #1 ngày 19/07` ➔ `Trụ cột #1 ngày 26/07` ➔ `Trụ cột #1 ngày 16/11`). |
| **Phản hồi Nhà sản xuất** | Chưa có | Cụm nút **Icon-only** (`👍` Thích, `👎` Không thích, `🚩` Report/Báo cáo) gửi phản hồi trực tiếp tới nhà làm sản phẩm qua `/api/feedback`. |

---

## 2. Đặc tả Hợp đồng Dữ liệu (Data Contract) giữa Các Tầng

### 2.1. Quy tắc Luân phiên 1 Trụ cột / Ngày (Deterministic Daily Rotation)
- Ngày chuẩn (anchor date): `2026-11-16` ➔ **Trụ cột #1** (`Tăng huyết áp & Yếu tố nguy cơ`).
- Công thức:
  ```python
  delta_days = (target_date - datetime.date(2026, 11, 16)).days
  pillar_id = (delta_days % 10) + 1
  ```
- Kiểm chứng:
  - `2026-11-15` (Hôm qua): `(-1 % 10) + 1 = 10` ➔ **Trụ cột #10**
  - `2026-11-16` (Hôm nay): `(0 % 10) + 1 = 1` ➔ **Trụ cột #1**
  - `2026-11-17` (Ngày mai): `(1 % 10) + 1 = 2` ➔ **Trụ cột #2**

### 2.2. Cấu trúc JSON Chuẩn của Một `briefing` trong `data/briefings.js`
Tuyệt đối **KHÔNG** chứa trường `crawled_articles`. Mỗi bản tin phải có:
```json
{
  "id": "ebm-2026-11-16-p1-main",
  "date": "2026-11-16",
  "week_label": "Tuần 46 • 16/11/2026 (Hôm nay)",
  "short_date": "16/11",
  "time": "07:00 AM",
  "model_used": "ebm-guideline-evolution-verified",
  "pillar_id": 1,
  "pillar_name": "Hypertension & Risk Factors",
  "pillar_vi": "Tăng huyết áp & Các yếu tố nguy cơ tim mạch",
  "topic_focus_vi": "Quản lý Huyết áp theo Nguy cơ Liên tục & Đích HATT 120–129 mmHg",
  "topic_focus_en": "Continuous CV Risk-Based BP Management & SBP 120–129 mmHg",
  "title_vi": "Sự chuyển dịch sang Quản lý Huyết áp theo Nguy cơ Liên tục và Đích HATT 120–129 mmHg",
  "title_en": "Transition to Continuous Risk-Based Blood Pressure Management and 120–129 mmHg SBP Targets",
  "word_count_vi": 1520,
  "verified_step0": true,
  "guideline_evolution": {
    "prior_guideline": {
      "name": "2018 ESC/ESH Guidelines for the management of arterial hypertension",
      "year": "2018",
      "doi": "10.1093/eurheartj/ehy339",
      "pmid": "30165516"
    },
    "current_guideline": {
      "name": "2024 ESC Guidelines for the management of elevated blood pressure and hypertension",
      "year": "2024",
      "doi": "10.1093/eurheartj/ehae178",
      "pmid": "39210715"
    },
    "steps": [
      {
        "era_label_vi": "Chỉ dẫn A • ESC/ESH 2018",
        "era_label_en": "Directive A • 2018 ESC/ESH",
        "title_vi": "Ngưỡng ≥140/90 mmHg & Đích 2 bước (<140 rồi <130)",
        "title_en": "≥140/90 mmHg Threshold & Two-Step Target",
        "desc_vi": "...",
        "desc_en": "..."
      },
      {
        "era_label_vi": "Động lực chuyển dịch • RCTs Bản lề",
        "era_label_en": "Paradigm Shift • Landmark Trials",
        "title_vi": "SPRINT (2015) • ESPRIT (2024) • BPROAD (2025)",
        "title_en": "SPRINT (2015) • ESPRIT (2024) • BPROAD (2025)",
        "desc_vi": "...",
        "desc_en": "..."
      },
      {
        "era_label_vi": "Chỉ dẫn B • ESC 2024 (Hiện hành)",
        "era_label_en": "Directive B • 2024 ESC (Current)",
        "title_vi": "Elevated BP & Đích thống nhất 120–129 mmHg (COR I, LOE A)",
        "title_en": "Elevated BP & Unified SBP 120–129 mmHg (Class I, LOE A)",
        "desc_vi": "...",
        "desc_en": "..."
      }
    ]
  },
  "landmark_trials": [
    {
      "name": "SPRINT",
      "journal": "NEJM 2015",
      "endpoint_label": "Primary MACE Composite",
      "value": "HR 0.75",
      "ci": "95% CI: 0.64–0.89",
      "p": "p < 0.001",
      "nnt": "NNT = 61 (3.26y)",
      "changes_vi": "...",
      "caution_vi": "...",
      "changes_en": "...",
      "caution_en": "..."
    }
  ],
  "pearls": [
    { "type": "guideline", "text_vi": "...", "text_en": "..." },
    { "type": "trial", "text_vi": "...", "text_en": "..." }
  ],
  "pubmed_anchors": [ ... ],
  "part1_vi_markdown": "...",
  "part2_en_markdown": "..."
}
```

---

## 3. Phân công & Danh sách Công việc Cho Từng Agent

### Agent 1: Kiến trúc sư Dữ liệu Guideline Evolution & Lịch sử Theo Trụ cột
- **File sở hữu**: [pillar_library.py](file:///Users/dinhduy/AI/daily_cardiology_ebm/pillar_library.py), [build_seed_briefings.py](file:///Users/dinhduy/AI/daily_cardiology_ebm/build_seed_briefings.py)
- **Nhiệm vụ**:
  - [x] Chuẩn hóa Trụ cột #1 kỳ hiện tại (`2026-11-16`) theo **100% nội dung trong `expected_output.md`** (Block A đối chiếu 2018 vs 2024 ESC, Cơ sở sinh lý bệnh & Pitfalls, Block B gồm `SPRINT`, `ESPRIT`, `BPROAD`, Pearls, Disclaimer, và bản dịch học thuật Phần 2).
  - [x] Xây dựng cấu trúc `guideline_evolution` (3 thế hệ chuyển dịch rõ ràng từ Guideline cũ → RCTs → Guideline mới), `landmark_trials`, và `pearls` cho toàn bộ 10 Trụ cột (`#1` → `#10`), sử dụng PMID/DOI đã xác thực qua PubMed.
  - [x] Bổ sung dữ liệu **Lịch sử đa tuần** cho mỗi Trụ cột `#1` → `#10` (mỗi trụ cột có ít nhất 4 kỳ theo trục thời gian, đặc biệt Trụ cột #1 có đủ chuỗi `12/07` ➔ `19/07` ➔ `26/07` ➔ `16/11 (Hôm nay)` và chu kỳ 10 ngày gần nhất `07/11` [#2] ... `15/11` [#10] ➔ `16/11` [#1]).
  - [x] Chạy `build_seed_briefings.py` tạo `data/briefings.js` sạch, không còn `crawled_articles`.

### Agent 2: Kỹ sư Backend (Xoay vòng 1 Trụ cột/Ngày, Auth & Feedback API)
- **File sở hữu**: [fetch_daily_ebm.py](file:///Users/dinhduy/AI/daily_cardiology_ebm/fetch_daily_ebm.py)
- **Nhiệm vụ**:
  - [x] Thay thế cơ chế crawl 10 trụ cột/ngày bằng `get_pillar_for_date(date)` (1 trụ cột duy nhất mỗi ngày theo số tiến `1 → 2 → ... → 10`, neo `2026-11-16` = Trụ cột #1).
  - [x] Cập nhật `refresh_today_briefing()` và `/api/refresh-stream` (SSE `%`): khi bấm Cập nhật hoặc auto 07:00 AM, chỉ xác thực NCBI PubMed Step-0 cho Guideline + Landmark Trials của **đúng 1 Trụ cột hôm nay** và xuất bản bản tin tiến hóa khuyến cáo.
  - [x] Xây dựng hệ thống xác thực tài khoản (`data/users.json` + token SHA-256/HMAC nhẹ, khởi tạo sẵn 1 tài khoản bác sĩ mẫu `bs.timmach` / `123456` để trải nghiệm 1-click):
    - `POST /api/auth/login`
    - `POST /api/auth/register`
    - `GET /api/auth/me`
    - `POST /api/user/activity` (lưu `read_ids`, `bookmarked_ids`)
  - [x] Xây dựng API phản hồi nhà sản xuất (`data/feedback.json`):
    - `GET /api/feedback`
    - `POST /api/feedback` (`like`, `dislike`, `report` kèm phân loại lỗi và nội dung góp ý).
  - [x] Cập nhật `/api/status` trả thêm `today_pillar`, `yesterday_pillar`, `tomorrow_pillar`, tổng số liệu feedback và user context.

### Agent 3: Kỹ sư Giao diện Supabase UI (`index.html`)
- **File sở hữu**: [index.html](file:///Users/dinhduy/AI/daily_cardiology_ebm/index.html)
- **Nhiệm vụ**:
  - [x] Thiết kế **Cổng Đăng nhập / Đăng ký (Auth Gate)** + Thanh Hồ sơ Bác sĩ trên Navbar (hiển thị tên người dùng, số bài đã đọc, tab bài đã lưu, đăng xuất).
  - [x] Chuyển giao diện sang chế độ **1 Trụ cột / Ngày theo số tiến**: hiển thị rõ chu trình `Hôm qua: Trụ cột #10` ➔ `Hôm nay: Trụ cột #1` ➔ `Ngày mai: Trụ cột #2`; trên dải 10 trụ cột chỉ đánh dấu "Hôm nay" cho 1 trụ cột của ngày hiện tại.
  - [x] Bổ sung chế độ **Lịch sử & Sơ đồ Lịch sử Riêng cho Từng Trụ cột**:
    - Cho phép chọn bất kỳ trụ cột nào (VD: Trụ cột #1) để xem các kỳ xuất bản ở tuần cũ.
    - Vẽ **Sơ đồ Tiến hóa Lịch sử Trụ cột** (chỉ giới hạn các mốc của đúng 1 trụ cột đó, VD: `Trụ cột #1 • 12/07` ➔ `Trụ cột #1 • 19/07` ➔ `Trụ cột #1 • 26/07` ➔ `Trụ cột #1 • 16/11 Hôm nay`), có thể bấm trực tiếp vào từng nút trên sơ đồ để đọc toàn văn.
  - [x] Cập nhật khối **Diễn Tiến Khuyến Cáo Thực Hành (Guideline Evolution)** thể hiện sự phát triển từ Chỉ dẫn A ở Guideline cũ ➔ Landmark RCTs ➔ Chỉ dẫn B ở Guideline hiện hành (thay thế hoàn toàn bước crawl data).
  - [x] Thêm cụm nút **Phản hồi Nhà làm sản phẩm hoàn toàn bằng Icon** (`👍` Thích, `👎` Không thích, `🚩` Report/Báo cáo) kèm modal gửi báo cáo/góp ý gửi lên `/api/feedback`.

---

## 4. Nhật ký Kiểm thử & Nghiệm thu
- [x] **Bước 1**: Tạo `AGENT_IMPLEMENTATION_PLAN.md` và phân công cho 3 Agent.
- [x] **Bước 2**: Agent 1 hoàn thành dữ liệu Guideline Evolution chuẩn `expected_output.md` và lịch sử theo trụ cột.
- [x] **Bước 3**: Agent 2 hoàn thành backend xoay vòng 1 trụ cột/ngày, Auth API và Feedback API.
- [x] **Bước 4**: Agent 3 hoàn thành giao diện Supabase UI đầy đủ đăng nhập, 1 trụ cột/ngày, sơ đồ lịch sử từng trụ cột, và phản hồi bằng icon.
- [x] **Bước 5**: Kiểm thử tích hợp End-to-End qua CLI (`build_seed_briefings.py`, `fetch_daily_ebm.py --refresh`), HTTP API (`/api/status`, `/api/auth/*`, `/api/user/activity`, `/api/feedback`, `/api/refresh-stream`), và kiểm tra cú pháp/DOM `index.html` (`node --check` + mở trực tiếp `http://127.0.0.1:8088`; ghi chú: `chrome_devtools` MCP không khả dụng trong phiên này nên không chạy click tự động bằng DevTools subagent).
