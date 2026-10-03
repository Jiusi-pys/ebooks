use crate::Result;

/// Shared acceptance gate for Web queue removal and native cursor advancement.
/// Legacy peers omit `persisted`; a valid ID and positive sequence still prove a receipt.
pub fn validate_sync_receipts(
    operation_ids: &[String],
    receipts: &serde_json::Value,
) -> Result<()> {
    let entries = receipts
        .as_array()
        .filter(|v| v.len() == operation_ids.len())
        .ok_or("invalid_sync_receipts")?;
    for (operation_id, receipt) in operation_ids.iter().zip(entries) {
        if receipt["operationId"] != *operation_id
            || receipt.get("persisted").is_some_and(|v| v != true)
            || receipt.get("error").is_some()
            || !receipt["seq"].as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 20
                    && s.bytes().all(|b| b.is_ascii_digit())
                    && s.parse::<u64>().is_ok_and(|n| n > 0)
            })
        {
            return Err("sync_not_persisted".into());
        }
    }
    Ok(())
}
