# CubeForge IDE

STM32向けに特化した VS Code フォークです。

この README は、このリポジトリの実行方法、開発方法、IDE の使い方、STM32 機能の使い方を 1 か所にまとめた運用ガイドです。

## これは何か

CubeForge IDE は、VS Code をベースに STM32 開発向け機能を追加した統合開発環境です。

主な構成は次のとおりです。

- `extensions/stm32-core`: ビルド、書込み、デバッグ、CubeMX/CubeCLT 連携
- `extensions/stm32-ai`: AI アシスタント、MCP、ビルドエラー修正支援
- `extensions/stm32-ux`: ウェルカム、チュートリアル、テンプレート、環境チェック
- `extensions/stm32-collab`: 共同作業、LAN 共有、git daemon、デバッグ共有、品質監査

## いま何が使えるか

現時点で使える主要機能です。

- STM32 プロジェクトのビルド、書込み、デバッグ
- `.ioc` の確認、コード再生成導線、ピン可視化
- AI パネルからのチャット、半自動フロー、全自動フロー
- 初心者向けウェルカム、L チカチュートリアル、テンプレートギャラリー
- 共同作業セッション開始、LAN 共有、ZIP 共有、git daemon、読み取り専用デバッグ共有
- 品質監査レポート生成

未完了または暫定の部分です。

- Y.js + WebRTC の正式プロバイダ差し替え前で、現在の共同編集同期は軽量な LAN 同期実装です
- Playwright による E2E 全自動化は未完了です
- ベータ配布パイプラインの最終化は未完了です

## 前提環境

Windows を前提にすると、最低限次が必要です。

- Node.js と npm
- Git
- Electron 実行に必要な一般的な開発環境
- STM32CubeCLT
- STM32CubeProgrammer
- 必要に応じて STM32CubeMX
- ST-LINK ドライバ

STM32 機能を使うだけなら、少なくとも次が必要です。

- `STM32CubeCLT_metadata`
- `STM32_Programmer_CLI`
- `arm-none-eabi-gcc`
- `git`

## セットアップ

### 1. 依存関係を入れる

```powershell
npm install
```

### 2. Electron を取得する

```powershell
npm run electron
```

### 3. ビルド監視を起動する

推奨は VS Code のタスク `VS Code - Build` です。

ターミナルでやる場合は次でも構いません。

```powershell
npm run watch
```

## 起動方法

### 開発用デスクトップ起動

もっとも基本の起動です。

```powershell
.\scripts\code.bat
```

VS Code タスクを使う場合は次です。

- `Run Dev`

### Sessions ウィンドウで起動

```powershell
.\scripts\code.bat --sessions
```

VS Code タスクを使う場合は次です。

- `Run Dev Sessions`
- `Run and Compile Dev Sessions`

### Web 版起動

```powershell
.\scripts\code-web.bat --port 8080 --browser none
```

またはタスク。

- `Run code web`

### Code Server 起動

```powershell
.\scripts\code-server.bat --no-launch --connection-token dev-token --port 8080
```

またはタスク。

- `Run code server`

## よく使う開発コマンド

### 型チェック

```powershell
npm run compile-check-ts-native
```

### Lint

```powershell
npm run eslint
```

### Hygiene

```powershell
npm run hygiene
```

### レイヤーチェック

```powershell
npm run valid-layers-check
```

### 単体テスト系

```powershell
.\scripts\test.bat
```

### ブラウザ系テスト

```powershell
npm run test-browser
```

### スモークテスト

```powershell
npm run smoketest
```

## IDE の基本的な使い方

### 1. IDE を起動する

- ビルド監視を有効にする
- `scripts/code.bat` で起動する
- 初回は STM32 関連ツールの検出を済ませる

### 2. ワークスペースを開く

- STM32 プロジェクトフォルダを開く
- もしくは CubeIDE プロジェクトをインポートする

### 3. STM32 環境を確認する

コマンドパレットから次を使います。

- `STM32 UX` の環境チェック
- `stm32ux.runEnvironmentCheck`

検出対象。

- CubeMX
- CubeCLT
- STM32 Programmer
- GCC
- Git

### 4. プロジェクトをビルドする

想定コマンド。

- `STM32: ビルド (Debug)`
- `STM32: ビルド (Release)`
- `STM32: フルリビルド`
- `STM32: クリーン`

ビルド結果は次で確認します。

- ボトムパネルのビルドログ
- 問題タブ
- コードサイズ分析

### 5. マイコンへ書き込む

想定コマンド。

- `STM32: 書込み`
- `STM32: 書込みと検証`
- `STM32: 全消去`

前提。

- ST-LINK が接続されていること
- ビルド成果物が生成済みであること

### 6. デバッグする

想定操作。

- `F5`: デバッグ開始/続行
- `Shift+F5`: 停止
- `F10`: ステップオーバー
- `F11`: ステップイン
- `Shift+F11`: ステップアウト
- `F9`: ブレークポイント設定/解除

確認できる内容。

- コールスタック
- 変数
- Live Expressions
- レジスタ
- メモリ
- 逆アセンブリ
- SWV/ITM
- Fault Analyzer

## STM32 機能の使い方

### 新規 STM32 プロジェクト

想定フロー。

1. コマンドパレットを開く
2. `STM32: 新規プロジェクトを作成...` を実行する
3. MCU またはボードを選ぶ
4. 必要なテンプレートを選ぶ
5. 生成後にビルドする

### CubeIDE プロジェクトを取り込む

1. コマンドパレットを開く
2. `STM32: CubeIDEプロジェクトをインポート...` を実行する
3. `.project` と `.cproject` を含むフォルダを選ぶ
4. 生成された `.vscode/tasks.json` と `launch.json` を確認する
5. Debug ビルドを 1 回実行する

### `.ioc` を使う

1. `.ioc` ファイルを開く
2. 専用エディタまたはピンビューで設定を見る
3. 必要なら CubeMX を起動する
4. `STM32: コードを再生成 (iocから)` を実行する
5. USER CODE セクションが保護されていることを確認する

### ピン設定ビュー

使い方。

1. アクティビティバーのピン設定を開く
2. MCU パッケージ図からピンを選ぶ
3. 右パネルで機能を変更する
4. 必要なら `.ioc` に反映する
5. コード再生成を実行する

### コードサイズ分析

1. ビルド完了後にサイズ分析を開く
2. `.text`, `.data`, `.bss` の使用量を見る
3. 大きいシンボルを確認する
4. 最適化対象を決める

## AI 機能の使い方

### AI パネルを開く

想定コマンド。

- `AI: チャットを開く`
- `stm32ai.openAssistantPanel`
- `stm32ai.openChat`

### できること

- 選択コードの説明
- ビルドエラー修正の提案
- 半自動フローの実行
- 全自動フローの実行
- HardFault 解析
- STM32 コンテキスト付きチャット

### よく使う流れ

#### ビルドエラー修正

1. ビルドする
2. 問題タブにエラーを出す
3. `AI: ビルドエラーを修正` を使う
4. 提案内容を確認する
5. 再ビルドする

#### 半自動フロー

1. AI にやりたいことを指示する
2. コード差分を確認する
3. 適用する
4. AI がビルドまで実行する
5. 書込み確認で止める

#### 全自動フロー

1. 全自動モードを有効にする
2. AI にビルドと書込みを依頼する
3. 書込み前の安全確認を通す
4. 完了を確認する

## 初心者向け機能の使い方

### ウェルカムウィザード

初回起動時に次の導線を選べます。

- はじめて使う
- CubeIDE から移行
- すぐ始める

### L チカチュートリアル

1. MCU を選ぶ
2. 新規プロジェクトを作る
3. PA5 を GPIO 出力にする
4. コード再生成する
5. USER CODE に L チカ処理を書く
6. ビルドする
7. 書き込む

### テンプレートギャラリー

カテゴリ別のテンプレートが使えます。

- GPIO Blinky
- UART Hello
- I2C Sensor
- SPI IMU
- ADC + DMA
- FreeRTOS
- USB
- LwIP
- FatFS
- ほか

## 共同作業機能の使い方

共同作業系は [extensions/stm32-collab/src/extension.ts](extensions/stm32-collab/src/extension.ts) にまとまっています。

### 1. 共同作業パネルを開く

- アクティビティバーの共同作業アイコンを開く
- もしくは `stm32collab.openPanel`

### 2. セッションを開始する

- `stm32collab.startSession`

動作。

- セッションコードを生成する
- クリップボードへコピーする
- LAN 告知を開始する

### 3. セッションに参加する

- `stm32collab.joinSession`
- または `stm32collab.discoverSessions`

動作。

- セッションコードを手入力できる
- 検出済みセッションを QuickPick で選べる

### 4. リアルタイム同期を使う

- `stm32collab.startRealtimeSync`
- `stm32collab.stopRealtimeSync`

現状。

- セッション単位で文書変更を同期します
- まだ正式な Y.js + WebRTC 差し替え前です
- 現在は軽量な LAN 同期の初期版です

### 5. LAN 共有を使う

- `stm32collab.startLanShare`
- `stm32collab.stopLanShare`

動作。

- HTTP 共有サーバーを起動する
- URL をクリップボードへコピーする
- セッション情報を配布する

### 6. ZIP 共有を使う

- `stm32collab.exportProjectZip`

生成物。

- `.stm32-share.zip`
- `.stm32-share.json`

### 7. Git 共有を使う

- `stm32collab.startGitDaemon`
- `stm32collab.stopGitDaemon`

用途。

- LAN 内の pull/push 用アドレスを配布する
- ローカル `git daemon` を起動する

### 8. デバッグ共有を使う

- `stm32collab.shareDebugSnapshot`

動作。

- アクティブなデバッグセッションから
  - スタックフレーム
  - ローカル変数
  を取得する
- JSON として読み取り専用共有情報を開く

### 9. 品質監査を使う

- `stm32collab.runQualityAudit`

生成物。

- `.stm32-quality-report.md`

内容。

- Diagnostics の件数
- 共同作業ポート設定
- アクセシビリティ観点
- セキュリティ観点
- パフォーマンス観点

## よく使うコマンド一覧

### 実行系

```powershell
npm install
npm run electron
npm run watch
.\scripts\code.bat
```

### 開発確認系

```powershell
npm run compile-check-ts-native
npm run eslint
npm run hygiene
npm run valid-layers-check
.\scripts\test.bat
npm run test-browser
npm run smoketest
```

### VS Code タスク名

- `VS Code - Build`
- `Run Dev`
- `Run Dev Sessions`
- `Run and Compile Dev Sessions`
- `Run code server`
- `Run code web`
- `Run tests`

## リポジトリ構成

```text
extensions/stm32-core      STM32 ビルド・書込み・デバッグ
extensions/stm32-ai        AI / MCP / 自動化
extensions/stm32-ux        ウェルカム / チュートリアル / テンプレート
extensions/stm32-collab    共同作業 / LAN 共有 / 品質監査
src/                       VS Code コア改変
resources/stm32/           テンプレート、SVD、スニペット、MCU 定義
scripts/                   起動スクリプト
build/                     ビルドスクリプト
```

## トラブル時の確認順

### IDE が起動しない

1. `npm install` を再実行する
2. `npm run electron` を実行する
3. `VS Code - Build` を回す
4. エラーがあれば型チェック結果を先に潰す

### STM32 ツールが見つからない

1. `stm32ux.runEnvironmentCheck` を実行する
2. PATH に CubeCLT / Programmer / GCC があるか確認する
3. `STM32CubeCLT_metadata` 単体実行が通るか確認する

### 書込みできない

1. ST-LINK 接続を確認する
2. CubeProgrammer CLI が実行可能か確認する
3. Debug ビルド成果物が生成済みか確認する
4. ポート、接続方式、周波数設定を確認する

### 共同作業が見えない

1. `stm32collab.startSession` でホストを開始する
2. `stm32collab.discoverSessions` を使う
3. Windows ファイアウォールや LAN セグメントを確認する
4. `stm32collab.discoveryPort`, `stm32collab.syncPort`, `stm32collab.sharePort`, `stm32collab.gitPort` の設定を確認する

## 現在の制約

- 共同編集は正式な Y.js + WebRTC 完全実装ではなく、先行の LAN 同期版です
- E2E テストは README 記載どおり全フロー自動化までは未完了です
- ベータ配布フローはまだ最終化されていません

## ライセンス

- このリポジトリのベースは MIT ライセンスです
- STM32CubeCLT と STM32CubeMX は別ライセンスのため、ユーザー側インストール前提です
- 詳細は `LICENSE.txt` と仕様書を参照してください
