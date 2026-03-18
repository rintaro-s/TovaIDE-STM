# PWM (tmp/Cube対応)

## 概要
LEDの明るさ制御などで使うPWMをSTM32で出力する。

## 最短フロー
1. ペリフェラルワークベンチで `PWM` を選ぶ。
2. `ボード設定` でプロジェクトを作成する。
3. Timerを有効化し、CHxを `PWM Generation` に設定する。
4. `fTIM / ((PSC+1)*(ARR+1))` で目標周波数になるよう `PSC` と `ARR` を決める。
5. ワークベンチでコード生成し、`USER CODE BEGIN 2` と `WHILE` へ貼り付ける。
6. ビルド -> 書込み -> 動作確認。

## CubeMX設定メモ
- Internal Clock を有効。
- CHxNよりCHxを優先。
- 例: 30kHz狙いなら `PSC=0` から開始し `ARR` を再計算。

## main.cで使う要点
- 開始: `HAL_TIM_PWM_Start(&htimX, TIM_CHANNEL_Y);`
- Duty更新: `__HAL_TIM_SET_COMPARE(&htimX, TIM_CHANNEL_Y, compare);`
- 比較値は `0..ARR` の範囲。

## つまずき対策
- PWMが出ない: Start関数呼び出し場所を `BEGIN 2` で確認。
- 周波数が違う: Clock設定と `PSC/ARR` を再確認。
- 明るさ変化が見えない: `HAL_Delay()` を一時的に増やす。
