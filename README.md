# 立直麻将记录

记录四人立直麻将的终局点数和 chips，自动计算马点，统计玩家之间的对局胜率。纯静态网页，可以免费部署在 GitHub Pages 上，在线浏览和记录。

## 功能

- **录入**：四家终局点数（或马点 pt）。可以留空一家，系统自动补齐。四家合计必须为 100,000 才能保存。1–4 位分别用金、蓝、灰、红标出。手机键盘没有负号时，点输入框旁的 **±** 切换正负（也可以输入 ▲ / △）。
- **当日 chips**：chips 不用每场填，一天（4–8 场）打完后在「录入」页下方的「当日 chips」里记一次每人的合计。每个日期一条记录。
- **照片识别**：上传手写记分表的照片，由 Gemini 识别出每一场的点数或马点和当日 chips，点一下填入表单，核对后保存。不填 API Key 时可以对照照片手动录入。
- **记录**：按月浏览，可以按玩家和同桌对手筛选，支持编辑和删除。
- **统计**：排行榜（总 pt、平均顺位、各顺位率、chips）。选中一位玩家后，可以看到他和每位对手同桌时的胜率（名次比对手高算胜）。
- **同步**：保存后自动提交到 GitHub 仓库的 `data/games.json`；也可以导入导出 JSON 和 CSV。

## 计分规则（默认，可在「设置」里修改）

起始 25000、返点 30000、马 +20 / +10 / −10 / −20，1 位另加头名赏 (30000−25000)×4/1000 = 20。

```
pt = (终局点数 − 30000) / 1000 + 马（1 位再 +20）
例：1 位 50000 → 20 + 20 + 20 = +60.0
```

照片上写的是马点时，切换到「马点 pt」录入，会自动换算回终局点数。

## 部署到 GitHub Pages

1. 新建一个公开仓库，把本目录的文件推上去：
   ```bash
   git init && git add . && git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<用户名>/<仓库名>.git
   git push -u origin main
   ```
2. 在仓库的 Settings → Pages → Source 里选 **Deploy from a branch**，分支 `main`，目录 `/ (root)`。
3. 访问 `https://<用户名>.github.io/<仓库名>/`。

## 在网页上记录并同步

1. 创建 GitHub Fine-grained Token：GitHub → Settings → Developer settings → Fine-grained tokens，只授权这个仓库，权限选 **Contents: Read and write**。
2. 打开网站，在「设置 → GitHub 同步」里填 Token。在 github.io 上，用户名和仓库名会自动识别。
3. （可选）照片识别使用 Gemini API：在 [Google AI Studio](https://aistudio.google.com/apikey) 创建 API Key，并在该 Key 所在项目点 **Set up billing** 开通付费层级（按量计费；付费层级的数据不会用于训练），再填到「设置 → 照片识别」。模型默认 `gemini-flash-latest`，可在设置里改。

两个 Key 都只保存在你自己浏览器的 localStorage 里，不会写进仓库。不要在公共电脑上保存。

## 本地运行

```bash
python3 -m http.server 8000   # 打开 http://localhost:8000
node test/scoring.test.mjs    # 测试计分逻辑
```

## 数据格式

`data/games.json`：`games` 是每一场对局，`chips` 是每天一条的 chips 记录：

```json
{ "version": 1,
  "games": [{ "id": "…", "date": "2026-11-15", "players": ["小明", "小红", "阿强", "老王"], "scores": [50000, 30000, 15000, 5000], "rules": {…} }],
  "chips": [{ "id": "chips-2026-11-15", "date": "2026-11-15", "players": ["小明", "小红", "阿强", "老王"], "chips": [3, -1, 0, -2] }] }
```

旧数据里每场自带的 `chips` 仍然会计入统计。

## 发布新版本

`index.html` 和 `js/app.js` 里的脚本、样式地址带有版本号（`?v=…`），防止手机浏览器混用新旧文件导致页面失效。改了 JS 或 CSS 后，发布前把版本号整体换掉：

```bash
V=$(date +%Y%m%d%H%M) && sed -i '' -E "s/\?v=[0-9-]+/?v=$V/g" index.html js/app.js
```

## CSV 导入格式

```csv
date,note,name1,score1,chips1,name2,score2,chips2,name3,score3,chips3,name4,score4,chips4
2026-11-15,友人场,小明,50000,3,小红,30000,-1,阿强,15000,0,老王,5000,-2
```

## 文件

```
index.html         页面
css/style.css      样式（跟随系统深色模式）
js/app.js          界面
js/scoring.js      计分与统计
js/recognize.js    照片识别（Gemini API）
js/store.js        本地存储与 GitHub 同步
data/games.json    对局数据
```
