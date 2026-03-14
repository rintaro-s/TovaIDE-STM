# CubeForge MCP Server

STM32開発向けのスタンドアローンMCPサーバーです。GitHub CopilotなどのAIクライアントからSTM32ツール群を呼び出せます。

## 起動方法

```bash
# ワークスペースのルートから実行
node mcp-server/index.js --workspace . --port 3737
```

## エンドポイント

| パス      | メソッド | 説明                       |
|-----------|----------|----------------------------|
| `/mcp`    | POST     | JSON-RPC 2.0 ツール呼び出し |
| `/health` | GET      | ヘルスチェック              |
| `/tools`  | GET      | ツール一覧 (JSON)           |

## 認証

起動時にワークスペースルートの `.mcp-token` にトークンが書き込まれます。  
リクエスト時は `Authorization: Bearer <token>` ヘッダーを付与してください。

## 利用可能なツール

| ツール名                  | 説明                                           |
|---------------------------|------------------------------------------------|
| `stm32.getProjectInfo`    | .iocファイルを解析してMCU/ペリフェラル情報取得 |
| `stm32.build`             | makeでDebugビルドを実行                         |
| `stm32.flash`             | ST-LINK経由でELFをフラッシュ書込み             |
| `stm32.regenerateCode`    | CubeMX CLIでコードを再生成                     |
| `stm32.analyzeHardFault`  | CFSR/HFSRレジスタをデコードして障害診断        |
| `stm32.listElfSymbols`    | arm-none-eabi-nmでコードサイズ分析             |
| `stm32.checkStLink`       | ST-LINK接続デバイスを検出                       |
| `stm32.readRegister`      | 実行中STM32のペリフェラルレジスタ読み取り       |

## JSON-RPC 使用例

```bash
# ビルド実行
curl -X POST http://127.0.0.1:3737/mcp \
  -H "Authorization: Bearer $(cat .mcp-token)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"stm32.build","params":{"jobs":8}}'

# HardFault解析
curl -X POST http://127.0.0.1:3737/mcp \
  -H "Authorization: Bearer $(cat .mcp-token)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"stm32.analyzeHardFault","params":{"cfsr":"0x00008200","hfsr":"0x40000000"}}'
```

## VSCode .mcp.json との連携

`.vscode/mcp.json` に以下を追加することでCopilotと統合できます：

```json
{
  "servers": {
    "cubeforge-stm32": {
      "type": "http",
      "url": "http://127.0.0.1:3737/mcp"
    }
  }
}
```
