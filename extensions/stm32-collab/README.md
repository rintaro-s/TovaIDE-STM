# STM32 Collaboration

`stm32-collab` は STM32 プロジェクト向けの共同作業機能を提供します。

## できること

- セッション作成・参加 (`startSession`, `joinSession`)
- LAN 共有 (`startLanShare`, `stopLanShare`)
- mDNS による近傍セッション検出 (`discoverSessions`)
- リアルタイム同期 (Yjs) (`startRealtimeSync`, `stopRealtimeSync`)
- WebSocket 同期サーバー (`startWsSync`, `stopWsSync`)
- Git daemon 共有 (`startGitDaemon`, `stopGitDaemon`)
- デバッグスナップショット共有 (`shareDebugSnapshot`)
- 品質監査 (`runQualityAudit`)
- プロジェクト ZIP 出力 (`exportProjectZip`)

## クイックスタート

1. コマンドパレットから `STM32: Open Collaboration Panel` を実行します。
2. ホスト側は `Start Session` を実行します。
3. 共有したい場合は `Start LAN Share` を実行します。
4. 参加側は `Join Session` でセッションコードを入力します。
5. 必要に応じて `Start Realtime Sync` または `Start WS Sync` を実行します。

## 推奨フロー

1. ホスト: `Start Session`
2. ホスト: `Start LAN Share`
3. 参加者: `Discover Sessions` か `Join Session`
4. 全員: `Start Realtime Sync`
5. 必要時: `Share Debug Snapshot` / `Run Quality Audit`

## 設定項目

- `stm32collab.sharePort` (default: `8080`): LAN 共有ポート
- `stm32collab.discoveryPort` (default: `5353`): セッション検出ポート
- `stm32collab.syncPort` (default: `40123`): リアルタイム同期ポート
- `stm32collab.gitPort` (default: `9418`): Git daemon ポート
- `stm32collab.wsSyncPort` (default: `40200`): WebSocket 同期ポート

## トラブルシューティング

- セッションが見つからない:
  - `discoverSessions` を再実行し、同一ネットワークか確認してください。
  - `discoveryPort` がファイアウォールでブロックされていないか確認してください。
- 同期できない:
  - 先に `Start Session` もしくは `Join Session` を実行してください。
  - `syncPort` / `wsSyncPort` が他プロセスと競合していないか確認してください。
- LAN 共有 URL に接続できない:
  - ホストの `sharePort` 公開設定とファイアウォールを確認してください。

## 関連コマンド

- `stm32collab.openPanel`
- `stm32collab.startSession`
- `stm32collab.joinSession`
- `stm32collab.discoverSessions`
- `stm32collab.startRealtimeSync`
- `stm32collab.stopRealtimeSync`
- `stm32collab.startLanShare`
- `stm32collab.stopLanShare`
- `stm32collab.startGitDaemon`
- `stm32collab.stopGitDaemon`
- `stm32collab.startWsSync`
- `stm32collab.stopWsSync`
- `stm32collab.shareDebugSnapshot`
- `stm32collab.runQualityAudit`
- `stm32collab.exportProjectZip`
