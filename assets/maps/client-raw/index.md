# 客户端底图排查清单（只读扫描）

- 扫描目标：`D:\GMZZLauncher`（《诡秘之主》WeGame/腾讯客户端）
- 扫描时间：2026-10-29
- 扫描方式：只读（仅枚举目录 + 读取文件头/尾部字节），未运行任何 exe / 未启动客户端 / 未写入被扫描目录
- 结论：**客户端内没有可用的干净地图底图或小地图图片**。0 个文件被复制到本目录。

---

## 一、目录结构摘要

```
D:\GMZZLauncher\                  ← Electron 启动器（非游戏本体）
├─ assets\banners\                ← 启动器宣传图（data.json + 少量图，非地图）
├─ locales\ resources\ plugins\   ← Chromium 相关
├─ log\ user.json 等
├─ 诡秘之主-录像\                 ← 玩家录像（9.23成品/素材，MP4，见第四节建议）
└─ Game\                          ← 真正的 UE 客户端根
   ├─ Lord of Mysteries.exe
   ├─ GamePackageConfig.txt       ← game_name=C7，版本 1.0.0 / 2018737
   └─ C7\                         ← UE 工程名 C7
      ├─ Binaries\Win64\
      │   ├─ C7-Win64-Shipping.exe (255 MB)   ← AES 密钥通常藏在这里
      │   └─ allin_data\                        ← 内嵌网页资源（wiki/登录/分享），无地图
      ├─ Content\Paks\                          ← 全部美术资源都在这里（见第二节）
      ├─ Engine\Content\                        ← 引擎自带资源，无项目内容
      └─ Saved\                                 ← 运行时缓存（截图、网页缓存）
```

`Content\Paks` 之外没有任何 `.uasset` / 贴图散文件，`Content\` 下只有 `Paks\` 一个子目录。

---

## 二、打包文件清单（地图贴图的实际位置）

`D:\GMZZLauncher\Game\C7\Content\Paks\` 共 59 个文件，合计约 **78.3 GB**：

| 扩展名 | 数量 | 总大小 | 说明 |
|---|---|---|---|
| `.ucas` | 47 | 69.85 GB | UE5 IoStore 数据块，主体资源 |
| `.upak` | 8 | 8.05 GB | 腾讯自定义索引/容器（`pakchunk9999-Windows.upak` 单文件 2.5 GB） |
| `.utoc` | 2 | 0.001 GB | `global.utoc`(974 B)、`pakchunk0-Windows.utoc`(647 KB) |
| `.pak` | 1 | 0.42 GB | `pakchunk0-Windows.pak`（446 MB，标准 UE Pak 尾部结构） |

主要分块：`pakchunk0*`（基础包）、`pakchunk9999*`（主内容，含 `_s1`~`_s18` 分片）、`pakchunk10001*`（可选内容）。
另有 `Game\C7\Saved\kscache\` 下约 15.4 GB 的下载缓存副本（`2153744` / `2218968` / `2228458` / `2255640` 四个目录），内容与 Paks 重复。

### 格式判定（只读验证结果）

1. `pakchunk0-Windows.pak` 尾部存在 UE Pak 魔数 `E1 12 6F 5A`，并带 `Oodle` 压缩标识 → 标准 UE4 Pak 结构。
2. 但该 Pak 全文扫描 `/Game/` 与 `.uasset` 字符串均为 **0 命中** → 索引被 AES 加密，文件名不可见。
3. `global.utoc` 与 `pakchunk0-Windows.utoc` 头部 16 字节是 `2D 3D 3D 2D 2D 3D 3D 2D 2D 3D 3D 2D 2D 3D 3D 2D`（即 ASCII `-==--==--==--==-`），不是 UE 标准的 `C1 83 2A 9E` → IoStore 头被腾讯二次混淆。
4. `pakchunk9999-Windows.upak`（2.5 GB）全文 2.33 GB 扫描：`/Game/` 0 命中、`.uasset` 0 命中，尾部亦无 Pak 魔数 → 索引加密的表驱动容器，**FModel 直接打开大概率失败**。

> 也就是说：文件名里查不到 `map / gvg / siege / minimap` 之类信息，资源在包内也没有明文路径可抄。

---

## 三、散落的图片候选（均已判定无关）

客户端内散图共 **2237 张**，全部来自运行时网页/社交/截图缓存，**没有一张是 GvG 地图或小地图**：

| 目录 | 数量 | 尺寸样例 | 判断理由 |
|---|---|---|---|
| `Saved\UI_Web_Cache\Chat` | 835 | 小图 | 聊天表情/头像 |
| `Saved\UI_Web_Cache\Moments` | 458 | 小图 | 朋友圈/动态配图 |
| `Saved\UI_Web_Cache\FashionStation(_CROP0)` | 567 | 竖版立绘 | 时装商城 |
| `Saved\UI_Web_Cache\GhostFestival` | 23 | 1920×1080 | 节日活动宣传图 |
| `Saved\UI_Web_Cache\ManorTemplate` | 22 | 2560×1440 | 庄园（家园）模板展示图 |
| `Saved\UI_Web_Cache\TheatreStation` | 76 | 1920×1080 | 剧场活动图 |
| `Saved\Photograph` / `GhostFestivalPhoto` | 36 + 17 | 相册截图 | 玩家拍照模式，非地图 |
| `Binaries\Win64\allin_data\`（wiki/share/login/quick_jump） | ~15 | 按钮图标 | 内嵌网页 UI 素材 |
| `Saved\UI_Web_Cache\CustomMAP` | 0 | — | 空目录（名字像地图，实际无内容） |

全客户端文件名关键字扫描（`map / world / gvg / siege / arena / minimap / ui_map / 猎龙 / 星墓 / 四方 / boss`）仅 3 条命中，全部无关：

- `D:\GMZZLauncher\Game\C7\Binaries\Win64\allin_data\common_webview\long-bg.png`（166 KB，网页背景图，`long` 误命中）
- `D:\GMZZLauncher\Game\C7\Binaries\Win64\allin_data\wiki\long-bg.png`（47 KB，同上）
- `D:\GMZZLauncher\resources\app.asar.unpacked\out\main\KMapview.node`（163 KB，Electron 原生模块，非图片）

`Saved\LocalResCrop` 为空目录。

---

## 四、结论与下一步建议

**结论：没有。** 客户端内不存在可直接取材的猎龙之城 / 四方战 / 星墓高原底图或小地图图片，本目录未复制任何文件（不凑数）。

可用路线（按成本从低到高）：

1. **游戏内截图裁切（推荐先做）**
   - `D:\GMZZLauncher\诡秘之主-录像\9.23素材`（sc1.1~sc8.2、cd1-2，共 18 个 MP4）与 `9.23成品\SSDT1~9.mp4`（9 个）是玩家录像，可能含大地图/据点视角，可逐帧导出做底图参考。
   - 或进游戏打开 GvG 地图/战场大地图界面截图（1920×1080，UI 截图不带透视畸变，最适合描图）。
2. **官方素材**：官网/官方公众号/攻略站的活动图里若有三张地图的宣传版平面图，可直接用于结构对照。
3. **Pak 解包（成本最高，需先解决加密）**
   - 工具：FModel（读 IoStore）或 UnrealPak（读标准 `.pak`）+ Oodle 解压库。
   - 障碍：索引 AES 加密（`.pak` 明文路径 0 命中）、`.utoc` 头被改写、`.upak` 为腾讯私有容器 → 需要从 `C7-Win64-Shipping.exe` 中定位 AES 密钥，且 `.upak` 可能需要自写插件/脚本，成功率不确定。
   - 建议顺序：先用 FModel 试 `pakchunk0-Windows.pak`（标准 UE 结构，最可能成功）→ 若拿到密钥再攻 `pakchunk9999` 系列。
   - 本步骤未执行任何下载、安装或运行。

> 涉及只读约束：扫描期间未修改/移动/删除 `D:\GMZZLauncher` 下任何文件，未运行任何可执行文件。
