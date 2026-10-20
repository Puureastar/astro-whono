# Nivalis

Pureastar 的个人博客：[blog.pureastar.top](https://blog.pureastar.top)。

## 写作与发布

文章、动态、附件和设置以 Git 仓库为唯一来源。写作后台保存后，手动检查、提交并推送 `blog` 分支，由 Cloudflare Pages 自动构建。

- 文章：`src/content/essay/`；附件放在对应文章的附件目录。
- 动态：`src/content/bits/`。
- 关于与小记：`src/content/about/index.md`、`src/content/memo/index.md`。
- 主题设置：`src/data/settings/`。

```sh
git status
git diff
git add -- 具体文件路径
git diff --cached
git commit -m "更新博客"
git push origin blog
```

公开仓库中提交的草稿源码也公开；`public/` 文件会随构建发布。

## 构建

Node.js 固定 `22.22.0`，保留锁文件。

```sh
npm ci
npm run check
SITE_URL=https://blog.pureastar.top npm run build
```

静态产物为 `dist`。开发后台用于私有写作，不作为公开 CMS。

基于 [Astro Whono](https://github.com/cxro/astro-whono)，保留原项目 MIT 许可证及字体许可。
