# 部署说明（公网 HTTPS）

微软商店要求 PWA 有公网 HTTPS 地址；Play 不强制，但网页版也需要一个可分享的地址。
三种方式任选其一，都是免费额度内。

## 0. 先生成站点

```sh
cd ~/.openclaw/agents/poker/workspace
./tools/build_site.sh          # 产出 dist/（约 400KB，不含 APK）
```

---

## 方案 A：Cloudflare Pages（推荐，国内可访问性最好）

1. 注册 https://dash.cloudflare.com → Workers & Pages → Create → Pages → Upload assets
2. 项目名填 `poker-trainer`，把 `dist/` 整个目录拖进去
3. 得到 `https://poker-trainer.pages.dev`
4. 之后更新：重复第 2 步，或改用 Git 集成（连仓库后自动构建，配置见 `wrangler.toml`）

命令行方式（需 `npm i -g wrangler` 并登录）：

```sh
cd ~/.openclaw/agents/poker/workspace
wrangler pages deploy dist --project-name poker-trainer
```

自定义域名：Pages → Custom domains → 添加你的域名。

---

## 方案 B：GitHub Pages（免费、和代码放一起）

1. 把 `~/.openclaw/agents/poker/workspace` 推到一个 GitHub 仓库的 `main` 分支
2. 仓库 Settings → Pages → Source 选 **GitHub Actions**
3. 工作流已就绪：`.github/workflows/pages.yml`，push 后自动构建 `dist/` 并发布
4. 地址：`https://<用户名>.github.io/<仓库名>/`

注意：仓库里不要放 APK/AAB（体积大）。`.gitignore` 建议忽略 `poker/*.apk`、`poker/*.aab`。

---

## 方案 C：Netlify

1. 注册 https://app.netlify.com → Add new site → Deploy manually，拖 `dist/`
2. 或连 Git 仓库，构建配置已在 `netlify.toml`（`command = sh tools/build_site.sh`，`publish = dist`）
3. 地址：`https://<随机名>.netlify.app`

---

## 部署后必须做的事

1. **改隐私政策邮箱**：`poker/privacy.html` 里两处 `privacy@example.com` 换成你的真实邮箱
2. **确认 Service Worker 生效**：打开站点 → DevTools → Application → Service Workers，应显示 activated
3. **验证离线**：断网后刷新，仍能进入牌桌
4. **验证 8 种语言**：`<你的域名>/?lang=en|ja|ko|es|pt|de|fr`
5. **把地址填进商店后台**的「隐私政策 URL」和「网站」字段

## 更新流程

```sh
# 改完 poker/ 下的前端文件后
./tools/build_site.sh                 # 重新生成 dist/
wrangler pages deploy dist --project-name poker-trainer   # 或重新拖拽
```

Service Worker 会缓存旧版本。改了 `app.js`/`style.css` 等文件时，记得把 `index.html` 里的
`?v=15` 递增，并同步改 `sw.js` 的 `CACHE` 常量，否则老用户拿到的是旧代码。
