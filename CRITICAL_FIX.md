# 緊急修正手順

## 問題
- 設定値は保存されているが環境チェックで「未検出」と表示される
- サイドバーで「ビュー データを提供できるデータ プロバイダーが登録されていません」エラー

## 原因
拡張が古いコンパイル済みコードを実行している。最新の修正が反映されていない。

## 解決手順

### 1. すべてのウィンドウを閉じる
VS Code / TovaIDE のすべてのウィンドウを完全に閉じてください。

### 2. 再コンパイル
```powershell
cd e:\github\TovaSTM
npm run compile
```

### 3. TovaIDE を起動
```powershell
.\scripts\code.bat
```

### 4. 拡張ホストをリロード
- `Ctrl+Shift+P` でコマンドパレットを開く
- `Developer: Reload Window` を実行

### 5. 環境チェックを実行
- `Ctrl+Shift+P` でコマンドパレットを開く
- `STM32 UX: 環境チェック` を実行
- OUTPUT チャンネルで `STM32 UX` を選択してログを確認

## 期待される結果

環境チェックで以下のように表示されるはずです:

```
- STM32CubeMX: ✅ C:\Users\s-rin\AppData\Local\Programs\STM32CubeMX\STM32CubeMX.exe
- STM32CubeCLT_metadata: ✅ E:\installs\cubeCLT\STM32CubeCLT_1.21.0\STM32CubeCLT_metadata.bat
```

## まだエラーが出る場合

OUTPUT チャンネルの `STM32 UX` ログを確認してください。以下のようなログが出力されます:

```
[STM32-UX] Checking CubeMX path: C:\Users\s-rin\...
[STM32-UX] CubeMX path exists: C:\Users\s-rin\...
```

もしくは:

```
[STM32-UX] CubeMX path check failed: [エラー内容]
```

このログ内容を教えてください。
