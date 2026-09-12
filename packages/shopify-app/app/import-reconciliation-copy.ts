export const importReconciliationCopy = {
  en: {
    title: "Import ledger reconciliation",
    run: "Reconcile import ledger",
    busy: "Checking ledger evidence…",
    error:
      "Reconciliation could not be confirmed. Refresh import status and try again.",
    notice:
      "Checks import ledger entries and provenance only. Cached wallet balances are not audited here.",
    clean:
      "Ledger evidence reconciles; the import is not fully committed or rolled back.",
    committed: "Ledger evidence reconciles and the import is fully committed.",
    rolledBack:
      "Ledger evidence reconciles and the import is fully rolled back.",
    mismatch: "Ledger evidence does not reconcile. Investigation is required.",
    imported: "Imported points",
    reversed: "Reversed points",
    expected: "Expected net points",
    observed: "Observed net points",
    issues: {
      missing_source_rows: "Source rows are missing",
      duplicate_ledger_identity: "Duplicate ledger identity",
      missing_or_reused_ledger_entry: "Missing or reused ledger entry",
      missing_ledger_entry: "Ledger entry is missing",
      ledger_provenance_mismatch: "Ledger provenance mismatch",
      reversal_sequence_or_balance_mismatch:
        "Reversal sequence or balance mismatch",
      duplicate_snapshot: "Duplicate source snapshot",
      invalid_opening_balance: "Invalid opening balance",
      execution_state_mismatch: "Row execution state mismatch",
      unclaimed_ledger_entry: "Unclaimed ledger entry",
      net_points_mismatch: "Net points mismatch",
      source_state_mismatch: "Source state mismatch",
    },
  },
  ja: {
    title: "インポート台帳の照合",
    run: "インポート台帳を照合",
    busy: "台帳の証跡を確認中…",
    error:
      "照合結果を確認できませんでした。インポートの状態を更新して再試行してください。",
    notice:
      "インポートの台帳記録と出所のみを確認します。ウォレットのキャッシュ残高は監査しません。",
    clean:
      "台帳の証跡は一致していますが、全件反映または全件ロールバックは完了していません。",
    committed: "台帳の証跡が一致し、全件の反映が完了しています。",
    rolledBack: "台帳の証跡が一致し、全件のロールバックが完了しています。",
    mismatch: "台帳の証跡が一致しません。調査が必要です。",
    imported: "反映ポイント",
    reversed: "取消ポイント",
    expected: "期待される差引ポイント",
    observed: "台帳の差引ポイント",
    issues: {
      missing_source_rows: "元データの行がありません",
      duplicate_ledger_identity: "台帳識別子が重複しています",
      missing_or_reused_ledger_entry: "台帳記録が欠落または再利用されています",
      missing_ledger_entry: "台帳記録がありません",
      ledger_provenance_mismatch: "台帳記録の出所が一致しません",
      reversal_sequence_or_balance_mismatch:
        "取消の順序または残高が一致しません",
      duplicate_snapshot: "元データのスナップショットが重複しています",
      invalid_opening_balance: "開始残高が無効です",
      execution_state_mismatch: "行の実行状態が一致しません",
      unclaimed_ledger_entry: "実行記録に紐付かない台帳記録があります",
      net_points_mismatch: "差引ポイントが一致しません",
      source_state_mismatch: "元データの状態が一致しません",
    },
  },
  vi: {
    title: "Đối soát sổ điểm nhập",
    run: "Đối soát sổ điểm nhập",
    busy: "Đang kiểm tra bằng chứng sổ điểm…",
    error:
      "Không xác nhận được kết quả đối soát. Hãy cập nhật trạng thái nhập rồi thử lại.",
    notice:
      "Chỉ kiểm tra bút toán nhập và nguồn gốc. Không kiểm toán số dư ví lưu đệm tại đây.",
    clean:
      "Bằng chứng sổ điểm khớp; bản nhập chưa được ghi hoặc hoàn tác toàn bộ.",
    committed: "Bằng chứng sổ điểm khớp và bản nhập đã được ghi toàn bộ.",
    rolledBack: "Bằng chứng sổ điểm khớp và bản nhập đã được hoàn tác toàn bộ.",
    mismatch: "Bằng chứng sổ điểm không khớp. Cần kiểm tra.",
    imported: "Điểm đã nhập",
    reversed: "Điểm đã hoàn tác",
    expected: "Điểm ròng dự kiến",
    observed: "Điểm ròng trên sổ",
    issues: {
      missing_source_rows: "Thiếu dòng dữ liệu nguồn",
      duplicate_ledger_identity: "Trùng định danh bút toán",
      missing_or_reused_ledger_entry: "Thiếu hoặc dùng lại bút toán",
      missing_ledger_entry: "Thiếu bút toán",
      ledger_provenance_mismatch: "Nguồn gốc bút toán không khớp",
      reversal_sequence_or_balance_mismatch:
        "Thứ tự hoặc số dư hoàn tác không khớp",
      duplicate_snapshot: "Trùng bản chụp dữ liệu nguồn",
      invalid_opening_balance: "Số dư ban đầu không hợp lệ",
      execution_state_mismatch: "Trạng thái thực thi dòng không khớp",
      unclaimed_ledger_entry: "Bút toán không có bản ghi thực thi tương ứng",
      net_points_mismatch: "Điểm ròng không khớp",
      source_state_mismatch: "Trạng thái nguồn không khớp",
    },
  },
};
