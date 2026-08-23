use super::*;

#[test]
fn difficulty_one_target_has_bitcoin_core_work() -> Result<(), WorkError> {
    // Arrange
    let target = difficulty_one_target()?;

    // Act
    let work = target.credited_work();

    // Assert
    assert_eq!(work.to_decimal_string(), "4295032833");

    Ok(())
}

#[test]
fn credited_work_uses_fixed_width_big_endian_binary() -> Result<(), WorkError> {
    // Arrange
    let work = difficulty_one_target()?.credited_work();
    let mut expected_bytes = [0_u8; 32];
    expected_bytes[27..].copy_from_slice(&[1, 0, 1, 0, 1]);

    // Act
    let serialized = work.to_be_bytes();
    let parsed = CreditedWork::from_be_bytes(serialized)?;

    // Assert
    assert_eq!(serialized, expected_bytes);
    assert_eq!(parsed, work);

    Ok(())
}

#[test]
fn credited_work_json_round_trips_as_canonical_decimal() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let work = difficulty_one_target()?.credited_work();

    // Act
    let json = serde_json::to_string(&work)?;
    let parsed = serde_json::from_str::<CreditedWork>(&json)?;

    // Assert
    assert_eq!(json, "\"4295032833\"");
    assert_eq!(parsed, work);

    Ok(())
}

#[test]
fn persisted_verified_progress_parses_zero_and_exact_work() -> Result<(), WorkError> {
    // Arrange
    let zero = "0".to_owned();
    let exact = "4295032833".to_owned();

    // Act
    let zero_progress = VerifiedProgress::try_from(zero)?;
    let exact_progress = VerifiedProgress::try_from(exact)?;

    // Assert
    assert_eq!(zero_progress, VerifiedProgress::zero());
    assert_eq!(exact_progress.to_decimal_string(), "4295032833");

    Ok(())
}

#[test]
fn equivalent_binary_zero_work_is_fractional_display_only() -> Result<(), WorkError> {
    // Arrange
    let work = difficulty_one_target()?.credited_work();

    // Act
    let equivalent_zero_bits = work.equivalent_binary_zero_work();

    // Assert
    assert!((equivalent_zero_bits - 32.000_022_013_947).abs() < 1e-12);

    Ok(())
}

#[test]
fn credited_work_accumulates_without_precision_loss() -> Result<(), WorkError> {
    // Arrange
    let difficulty_one_work = difficulty_one_target()?.credited_work();
    let mut light_target = [0xff_u8; 32];
    light_target[..5].fill(0);
    light_target[5] = 0x3f;
    let light_work = AssignedTarget::from_be_bytes(light_target)?.credited_work();

    // Act
    let accumulated = light_work.checked_add(difficulty_one_work)?;

    // Assert
    assert_eq!(accumulated.to_decimal_string(), "4402341543937");

    Ok(())
}

#[test]
fn assigned_target_rejects_non_fixed_width_binary() {
    // Arrange
    let short_target = [1_u8; 31];
    let long_target = [1_u8; 33];

    // Act
    let short_result = AssignedTarget::try_from(short_target.as_slice());
    let long_result = AssignedTarget::try_from(long_target.as_slice());

    // Assert
    assert_eq!(short_result, Err(WorkError::InvalidTargetLength));
    assert_eq!(long_result, Err(WorkError::InvalidTargetLength));
}

#[test]
fn assigned_target_rejects_zero() {
    // Arrange
    let zero_target = [0_u8; 32];

    // Act
    let result = AssignedTarget::from_be_bytes(zero_target);

    // Assert
    assert_eq!(result, Err(WorkError::ZeroTarget));
}

#[test]
fn target_boundaries_have_explicit_work() -> Result<(), WorkError> {
    // Arrange
    let maximum_target = AssignedTarget::from_be_bytes([0xff; 32])?;
    let mut minimum_target_bytes = [0_u8; 32];
    minimum_target_bytes[31] = 1;
    let minimum_target = AssignedTarget::from_be_bytes(minimum_target_bytes)?;

    // Act
    let easiest_work = maximum_target.credited_work();
    let hardest_work = minimum_target.credited_work();

    // Assert
    assert_eq!(easiest_work.to_decimal_string(), "1");
    assert_eq!(
        hardest_work.to_decimal_string(),
        "57896044618658097711785492504343953926634992332820282019728792003956564819968"
    );

    Ok(())
}

#[test]
fn credited_work_json_rejects_non_canonical_or_out_of_range_values() {
    // Arrange
    let invalid_json = [
        "\"\"",
        "\"0\"",
        "\"01\"",
        "\"1.0\"",
        "\"-1\"",
        "1",
        "\"115792089237316195423570985008687907853269984665640564039457584007913129639936\"",
    ];

    // Act
    let results = invalid_json.map(serde_json::from_str::<CreditedWork>);

    // Assert
    assert!(results.into_iter().all(|result| result.is_err()));
}

#[test]
fn credited_work_binary_rejects_zero() {
    // Arrange
    let zero_work = [0_u8; 32];

    // Act
    let result = CreditedWork::from_be_bytes(zero_work);

    // Assert
    assert_eq!(result, Err(WorkError::ZeroCreditedWork));
}

#[test]
fn credited_work_accumulation_rejects_overflow() -> Result<(), WorkError> {
    // Arrange
    let mut minimum_target_bytes = [0_u8; 32];
    minimum_target_bytes[31] = 1;
    let maximum_single_share_work =
        AssignedTarget::from_be_bytes(minimum_target_bytes)?.credited_work();

    // Act
    let result = maximum_single_share_work.checked_add(maximum_single_share_work);

    // Assert
    assert_eq!(result, Err(WorkError::CreditedWorkOverflow));

    Ok(())
}

fn difficulty_one_target() -> Result<AssignedTarget, WorkError> {
    let mut target_bytes = [0_u8; 32];
    target_bytes[4] = 0xff;
    target_bytes[5] = 0xff;
    AssignedTarget::from_be_bytes(target_bytes)
}
