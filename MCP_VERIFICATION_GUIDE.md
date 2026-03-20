# STM32 MCP Server Verification Guide

このガイドは、全てのMCPツールが正しく動作することを確認するための手順書です。
各ツールを順番に実行し、問題があれば詳細なデバッグ情報が返されます。

## 前提条件

- STM32プロジェクトが `E:\files\STMs\stm32-project8` に存在する
- MCU: STM32F303K8Tx
- ST-LINKが接続されている

## テスト手順

### 1. 環境検証 (stm32.validateEnvironment)

**目的**: 全てのツール（make, gcc, cubemx, programmer）が正しくインストールされているか確認

**実行方法**:
```
VS Code コマンドパレット → "STM32: Validate Environment"
または
MCP経由で stm32.validateEnvironment を呼び出し
```

**期待される結果**:
- `success: true`
- `checks` で全てのツールが `true`
- `readiness.forBuild: true`
- `readiness.forFlash: true`
- `readiness.forGenerate: true`
- `issues: []` (空配列)
- `summary: "All tools detected. Environment is ready."`

**トラブルシューティング**:
- `issues` と `recommendations` を確認
- 各ツールの `tried` 配列で解決パスを確認
- 不足しているツールをインストール

---

### 2. ST-LINK検出 (stm32.checkStLink)

**目的**: ST-LINKプローブが接続され、認識されているか確認

**実行方法**:
```
MCP経由で stm32.checkStLink を呼び出し
```

**期待される結果**:
- `success: true`
- `connected: true`
- `interface: "SWD"` または `"SWD-connect"`
- `board: (ボード名)`
- `sn: (シリアル番号)`
- `attemptLog` に成功ログ

**トラブルシューティング**:
- `attemptLog` で各試行の詳細を確認
- `troubleshooting` の手順に従う
- ケーブル接続、電源、ドライバーを確認

---

### 3. プロジェクト情報取得 (stm32.getProjectInfo)

**目的**: .iocファイルからMCU情報、ピン設定を読み取る

**実行方法**:
```
MCP経由で stm32.getProjectInfo を呼び出し
params: { workspacePath: "E:\\files\\STMs\\stm32-project8" }
```

**期待される結果**:
- `success: true`
- `mcu: "STM32F303K8Tx"`
- `pins` に PA5, PA7 の設定が含まれる
- `peripherals` に使用中のペリフェラルリスト

---

### 4. ビルド (stm32.build)

**目的**: プロジェクトをビルドし、ELFファイルを生成

**実行方法**:
```
MCP経由で stm32.build を呼び出し
params: { workspacePath: "E:\\files\\STMs\\stm32-project8", jobs: 8 }
```

**期待される結果**:
- `success: true`
- `exitCode: 0`
- `elfPath: "E:\\files\\STMs\\stm32-project8\\Debug\\stm32-project8.elf"`
- `makeCommand` に実行されたmakeコマンド
- `note: "Build succeeded. ELF file ready for flashing."`

**トラブルシューティング**:
- `makeResolved` でmakeパスを確認
- `gccResolved` でGCCパスを確認
- `resolutionTried` と `gccResolutionTried` で解決パスを確認
- `stderr` でビルドエラーを確認

---

### 5. フラッシュ (stm32.flash)

**目的**: ビルドしたELFファイルをSTM32にフラッシュし、プログラムを実行

**実行方法**:
```
MCP経由で stm32.flash を呼び出し
params: { workspacePath: "E:\\files\\STMs\\stm32-project8" }
```

**期待される結果**:
- `success: true`
- `flashCommand` に `-rst` フラグが含まれている
  - 例: `STM32_Programmer_CLI.exe -c port=SWD freq=4000 -w <path>.elf -v -rst`
- `note: "Flash completed with -rst flag (MCU will reset and run program immediately)"`
- `detection.connected: true`
- フラッシュ後、LEDが5秒間隔で交互に点滅

**重要**: `-rst` フラグの確認
- `flashCommand` フィールドを確認し、必ず `-rst` が含まれていること
- これがないとプログラムは実行されません

**トラブルシューティング**:
- `detection.attemptLog` でST-LINK検出の詳細を確認
- `programmerResolved` でプログラマーパスを確認
- `error` フィールドに詳細なエラー情報とトラブルシューティングガイド

---

### 6. コード再生成 (stm32.regenerateCode)

**目的**: .iocファイルからコードを再生成

**実行方法**:
```
MCP経由で stm32.regenerateCode を呼び出し
params: { workspacePath: "E:\\files\\STMs\\stm32-project8" }
```

**期待される結果**:
- `success: true`
- `makefileGenerated: true`
- `projectArtifacts.generated: true`
- `note: "Code regenerated successfully. Project is ready to build."`

**トラブルシューティング**:
- `cubemxResolved` でCubeMXパスを確認
- `fatalDiagnostics` でCubeMXエラーを確認
- `diagnostics` で警告を確認

---

### 7. その他のツール

#### stm32.operationDesk
- 現在のワークスペース、MCPサーバーの状態を確認

#### stm32.listWorkspaceFiles
- プロジェクト内の全ソースファイル (.c, .h, .ioc) をリスト

#### stm32.readFile
- ファイルの内容を読み取る
- 例: `{ filePath: "Core/Src/main.c" }`

#### stm32.writeFile
- ファイルに書き込む
- 注意: CubeMX生成ファイルには patchUserCode を使用

#### stm32.patchUserCode
- CubeMX生成ファイルの `/* USER CODE BEGIN */` セクションのみを編集
- 例: `{ filePath: "Core/Src/main.c", patches: [{ sectionName: "2", content: "HAL_GPIO_TogglePin(...);" }] }`

#### stm32.createIocFromPins
- 新しい .ioc ファイルを作成
- 例: `{ mcuName: "STM32F303K8Tx", pins: [{ pin: "PA5", mode: "GPIO_Output" }] }`

#### stm32.analyzeHardFault
- HardFaultレジスタをデコード
- 例: `{ cfsr: "0x00008200" }`

#### stm32.listElfSymbols
- ELFファイルの最大シンボルをリスト（コードサイズ解析用）

#### stm32.readRegister
- STM32のレジスタ値を読み取る
- 例: `{ address: "0x40020010" }`

---

## 重要な修正点

### 1. detectStLink 関数
- 詳細な `attemptLog` を追加
- 各試行の結果を記録
- デバッグが容易になった

### 2. toolFlash 関数
- `-rst` フラグが確実に追加される
- `flashCommand` フィールドで実行コマンドを確認可能
- 詳細なエラーメッセージとトラブルシューティングガイド
- ST-LINK検出失敗時の詳細なログ

### 3. toolBuild 関数
- `makeResolved`, `gccResolved` で解決パスを明示
- `makeCommand` で実行コマンドを確認可能
- 詳細なエラーメッセージとトラブルシューティングガイド

### 4. toolRegenerateCode 関数
- `cubemxResolved` で解決パスを明示
- 詳細なエラーメッセージとトラブルシューティングガイド

### 5. toolValidateEnvironment 関数
- `issues` と `recommendations` を追加
- 環境の問題を自動検出し、修正方法を提示

### 6. toolCheckStLink 関数
- `attemptLog` と `troubleshooting` を追加
- ST-LINK接続の問題を詳細に診断

---

## 検証チェックリスト

- [ ] 1. validateEnvironment: 全ツールが検出される
- [ ] 2. checkStLink: ST-LINKが接続される
- [ ] 3. getProjectInfo: プロジェクト情報が読み取れる
- [ ] 4. build: ビルドが成功し、ELFが生成される
- [ ] 5. flash: フラッシュが成功し、`-rst`フラグが含まれる
- [ ] 6. フラッシュ後、LEDが5秒間隔で点滅する
- [ ] 7. regenerateCode: コード再生成が成功する

全ての項目にチェックが入れば、MCPサーバーは正常に動作しています。

---

## デバッグのヒント

### ST-LINK が認識されない場合
1. `checkStLink` の `attemptLog` を確認
2. `Programmer path: <path>` で正しいパスか確認
3. 各 `Trying: <command>` の結果を確認
4. `ERROR (SWD): ENOENT` なら、プログラマーバイナリが見つからない
5. 手動で実行してみる: `STM32_Programmer_CLI.exe -c port=SWD -l`

### フラッシュ後にプログラムが実行されない場合
1. `flash` の結果から `flashCommand` を確認
2. `-rst` フラグが含まれているか確認
3. 含まれていない場合は、mcp-server/index.js の修正が適用されていない
4. MCPサーバーを再起動

### ビルドが失敗する場合
1. `build` の `stderr` を確認
2. `makeResolved` と `gccResolved` でツールパスを確認
3. `resolutionTried` で解決試行を確認
4. 手動でビルドしてみる: `cd E:\files\STMs\stm32-project8\Debug && make -j8 all`

---

## 連絡先

問題が解決しない場合は、以下の情報を提供してください：
1. 失敗したツール名
2. 返されたエラーメッセージ全体（JSON）
3. `attemptLog`, `resolutionTried` の内容
4. 環境情報（OS, STM32ツールのバージョン）
