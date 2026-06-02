# 台灣公司盡職調查系統（Taiwan Company DD Tool）

一個純前端的台灣公司盡職調查（Due Diligence）工具，串接**經濟部商工行政資料開放平臺**公開 API，無需後端，可直接部署至 GitHub Pages。

![screenshot](https://img.shields.io/badge/Data%20Source-GCIS%20Open%20Data-blue) ![license](https://img.shields.io/badge/License-MIT-green)

---

## 功能特色

| 功能 | 說明 |
|------|------|
| 🔍 公司名稱搜尋 | 關鍵字模糊搜尋，即時顯示結果列表 |
| 🔢 統一編號查詢 | 直接輸入 8 碼統編取得完整公司資訊 |
| 👤 負責人姓名查詢 | 查詢此人名下所有公司 |
| 📋 基本資料顯示 | 統一編號、登記現況、公司名稱、代表人、所在地、核准設立日期、資本額 |
| 👥 董監事資料 | 完整董事、監察人、法人代表一覽，可點擊人名查詢其他任職公司 |
| 🏢 分公司資料 | 列出所有分公司，可點擊跳轉查詢 |
| 🕸 關聯圖視覺化 | 力導向（Force-directed）關聯圖，自動繪製公司—人員—地址關聯 |
| 🖱 互動操作 | 關聯圖支援拖曳、縮放、點擊節點查詢 |
| 📤 匯出 PNG | 一鍵匯出關聯圖為圖片 |

---

## 快速開始

### 方法一：直接在瀏覽器開啟（本地使用）

```bash
git clone https://github.com/YOUR_USERNAME/taiwan-company-dd.git
cd taiwan-company-dd
# 直接用瀏覽器開啟 index.html
open index.html
```

> ⚠️ 部分瀏覽器對本地 `file://` 協定的 fetch 有 CORS 限制，建議使用本地伺服器：

```bash
# Python 3
python -m http.server 8080

# Node.js（需安裝 serve）
npx serve .
```

### 方法二：部署至 GitHub Pages

1. Fork 或上傳本專案至你的 GitHub repo
2. 進入 repo 的 **Settings → Pages**
3. Source 選擇 `main` 分支的 `/ (root)`
4. 等待約 1 分鐘，網站即上線

---

## API 說明與使用規範

本工具使用**經濟部商業發展署開放資料 API**，無需 API Key，但有以下限制：

| 項目 | 說明 |
|------|------|
| 每日查詢上限 | 平臺有每日介接次數限制 |
| IP 白名單 | 大量系統性使用需填寫告知書並申請 IP 白名單 |
| 聯絡信箱 | opendata.gcis@gmail.com |

申請流程：
1. 下載並填寫[使用告知書](https://data.gcis.nat.gov.tw/resources/doc/apply.doc)
2. 寄送至 opendata.gcis@gmail.com
3. 收到確認後即可正常使用

---

## 主要 API 端點對照

| 功能 | API UUID |
|------|----------|
| 公司基本資料（應用一） | `5F64D864-61CB-4D0D-8AD9-492047CC1EA6` |
| 公司基本資料（應用二） | `F05D1060-7D57-4763-BDCE-0DAF5975AFE0` |
| 公司關鍵字查詢 | `6BBA2268-1367-4B42-9CCA-BC17499EBE8C` |
| 公司董監事資料 | `4E5F7653-1B91-4DDC-99D5-468530FAE396` |
| 公司負責人查詢 | `4B61A0F1-458C-43F9-93F3-9FD6DA5E1B08` |
| 分公司資料 | `FDB8D2C8-573D-4276-BFA4-8D3925ABE1CB` |

---

## 專案結構

```
taiwan-company-dd/
├── index.html          # 主頁面
├── css/
│   └── style.css       # 樣式（深色工業風）
├── js/
│   ├── api.js          # GCIS API 封裝模組
│   ├── graph.js        # Canvas 力導向關聯圖引擎
│   └── app.js          # 主程式邏輯
└── README.md
```

---

## DD 使用情境

供應商盡職調查（Supplier Due Diligence）場景：

1. **輸入供應商公司名稱** → 確認公司登記狀態、資本額、成立時間
2. **查看代表人** → 點擊人名查詢其他任職公司，確認是否有利益衝突
3. **查看董監事** → 分析董事會組成，辨識法人代表背後的實際控制人
4. **加入關聯圖** → 比對多家公司的交叉持股、共同董事等關聯
5. **查看地址節點** → 確認是否為人頭公司（同地址大量公司）

---

## 注意事項

- 本工具**僅供參考**，不應作為唯一決策依據
- 資料來源為政府開放資料，更新頻率依平臺公告為準
- 個人查詢行為請自行確保符合資料使用規範
- 請勿用於大規模自動化爬取

---

## License

MIT License

資料版權歸屬：經濟部商業發展署
