# TovaIDE 自動修復機能テスト手順

## 修正内容

### 1. .ioc ファイルの自動修正
- **CubeMX CLI実行前に、必ず `ProjectManager.ToolChain=Makefile` を強制設定**
- 既存の値に関わらず、常にMakefileに上書き

### 2. ELFファイル検索の強化
- ワークスペースルートも検索対象に追加
- 標準的な場所で見つからない場合、再帰的に検索（最大深度3）
- ビルド成功後にELFファイルの存在を確認し、見つからない場合は警告

### 3. ビルド後の検証
- ビルド成功時にELFファイルが実際に生成されたか確認
- 見つからない場合は診断実行を提案

## テスト手順

### テスト1: .iocファイルの自動修正を確認

```powershell
# 現在のプロジェクトで実行
cd E:\files\STMs\stm32-project8

# MCPサーバー経由でコード再生成
# VS Code コマンドパレット: "MCP: Regenerate Code"
# または直接MCPを呼び出す
```

**期待される動作:**
1. `.ioc`ファイルが自動で読み込まれる
2. `ProjectManager.ToolChain` が自動的に `Makefile` に設定される
3. CubeMX CLIが実行される
4. `Makefile` が生成される

### テスト2: ビルドとELF検証

```powershell
# TovaIDEでビルド実行
# VS Code コマンドパレット: "STM32: Build Debug"
```

**期待される動作:**
1. ビルドが実行される
2. ビルド成功後、ELFファイルの存在が自動確認される
3. ELFファイルが見つかった場合:
   - 出力パネルに `[TovaIDE] Build succeeded. ELF: <path>` と表示
   - 成功メッセージが表示される
4. ELFファイルが見つからない場合:
   - 警告メッセージが表示される
   - 診断実行を提案される

### テスト3: フラッシュ

```powershell
# TovaIDEでフラッシュ実行
# VS Code コマンドパレット: "STM32: Flash Latest Build"
```

**期待される動作:**
1. ELFファイルが自動検出される（再帰検索含む）
2. ST-LINKが検出される（`-l` のみ使用、リセットなし）
3. フラッシュが成功する

## 実際のテスト実行

### ステップ1: プロジェクトをクリーン

```powershell
cd E:\files\STMs\stm32-project8
Remove-Item -Recurse -Force Core,Drivers,Debug,Release -ErrorAction SilentlyContinue
Remove-Item -Force Makefile,*.elf,*.bin,*.hex -ErrorAction SilentlyContinue
```

### ステップ2: TovaIDEを再起動

```powershell
# VS Code を再起動
# 自動診断が実行され、問題が検出される
```

### ステップ3: 自動修復を実行

```
通知: "TovaIDE detected X critical project issue(s). Auto-fix?"
→ "Fix Now" をクリック
→ CubeMXが起動
→ "Generate Code" をクリック（Toolchainは自動でMakefileに設定済み）
```

### ステップ4: ビルド

```
コマンドパレット: "STM32: Build Debug"
→ ビルドが実行される
→ ELFファイルが生成される
→ 出力パネルでELFパスが確認できる
```

### ステップ5: フラッシュ

```
コマンドパレット: "STM32: Flash Latest Build"
→ ELFファイルが自動検出される
→ ST-LINKが検出される（リセットなし）
→ フラッシュ成功
→ LEDが点滅する
```

## 検証ポイント

✅ `.ioc` ファイルが自動で `Makefile` に設定される  
✅ CubeMX CLI実行後に `Makefile` が生成される  
✅ ビルド成功後にELFファイルが確認される  
✅ ELFファイルが見つからない場合に警告が出る  
✅ フラッシュ時にELFファイルが自動検出される  
✅ ST-LINK検出時にマイコンがリセットされない（`-l` のみ）  

## トラブルシューティング

### Makefileが生成されない

**原因:** CubeMXが `.ioc` の `ToolChain` 設定を無視している

**解決策:**
1. 出力パネルで `.ioc` が修正されたか確認
2. `.ioc` ファイルを直接開いて `ProjectManager.ToolChain=Makefile` を確認
3. CubeMXを手動で起動して確認

### ELFファイルが見つからない

**原因:** ビルドは成功したがELFが生成されていない

**解決策:**
1. 出力パネルで再帰検索のログを確認
2. `find . -name "*.elf"` で手動検索
3. Makefileの `BUILD_DIR` 設定を確認

### ビルドエラー

**原因:** HALライブラリが不足

**解決策:**
1. `STM32: Health Check` を実行
2. 診断結果に従って修復
3. CubeMXで再生成
