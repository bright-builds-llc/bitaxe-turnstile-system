use std::io::{Error, ErrorKind};

use bwg_core::work::{AssignedTarget, CreditedWork, WorkError};
use serde::Deserialize;
use thiserror::Error as ThisError;

#[derive(Deserialize)]
struct WorkVectors {
    profile: String,
    target_vectors: Vec<TargetVector>,
    accumulation_vectors: Vec<AccumulationVector>,
    negative_vectors: NegativeVectors,
}

#[derive(Deserialize)]
struct TargetVector {
    id: String,
    assigned_target_be_hex: String,
    credited_work_decimal: String,
    credited_work_be_hex: String,
    equivalent_binary_zero_work: String,
}

#[derive(Deserialize)]
struct AccumulationVector {
    id: String,
    credited_work_inputs_decimal: Vec<String>,
    accumulated_work_decimal: String,
    accumulated_work_be_hex: String,
}

#[derive(Deserialize)]
struct NegativeVectors {
    assigned_targets: Vec<InvalidTargetVector>,
    accumulations: Vec<InvalidAccumulationVector>,
}

#[derive(Deserialize)]
struct InvalidTargetVector {
    id: String,
    assigned_target_be_hex: String,
    expected_error: TargetErrorCode,
}

#[derive(Deserialize)]
struct InvalidAccumulationVector {
    id: String,
    credited_work_inputs_decimal: Vec<String>,
    expected_error: AccumulationErrorCode,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TargetErrorCode {
    InvalidTargetLength,
    ZeroTarget,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AccumulationErrorCode {
    CreditedWorkOverflow,
}

#[derive(Debug, ThisError, PartialEq, Eq)]
enum VectorAccumulationError {
    #[error("accumulation vector needs inputs")]
    MissingInputs,
    #[error(transparent)]
    Work(#[from] WorkError),
}

#[test]
fn published_work_vectors_match_the_public_contract() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors: WorkVectors =
        serde_json::from_str(include_str!("../conformance/bwg-0.1/work-vectors.json"))?;

    // Act and Assert
    assert_eq!(vectors.profile, "BWG/0.1");
    for vector in vectors.target_vectors {
        assert_target_vector(&vector)?;
    }
    for vector in vectors.accumulation_vectors {
        assert_accumulation_vector(&vector)?;
    }
    for vector in vectors.negative_vectors.assigned_targets {
        assert_invalid_target_vector(&vector)?;
    }
    for vector in vectors.negative_vectors.accumulations {
        assert_invalid_accumulation_vector(&vector)?;
    }

    Ok(())
}

fn assert_target_vector(vector: &TargetVector) -> Result<(), Box<dyn std::error::Error>> {
    let target_bytes = decode_hex(&vector.assigned_target_be_hex)?;
    let target = AssignedTarget::try_from(target_bytes.as_slice())?;
    let work = target.credited_work();
    let expected_work_bytes = decode_fixed_width_hex(&vector.credited_work_be_hex)?;
    let expected_equivalent = vector.equivalent_binary_zero_work.parse::<f64>()?;

    assert_eq!(
        work.to_decimal_string(),
        vector.credited_work_decimal,
        "{}",
        vector.id
    );
    assert_eq!(work.to_be_bytes(), expected_work_bytes, "{}", vector.id);
    assert_eq!(
        serde_json::to_value(work)?,
        vector.credited_work_decimal,
        "{}",
        vector.id
    );
    assert!(
        (work.equivalent_binary_zero_work() - expected_equivalent).abs() < 1e-12,
        "{}",
        vector.id
    );

    Ok(())
}

fn assert_accumulation_vector(
    vector: &AccumulationVector,
) -> Result<(), Box<dyn std::error::Error>> {
    let accumulated = accumulate_decimal_inputs(&vector.credited_work_inputs_decimal)?;

    assert_eq!(
        accumulated.to_decimal_string(),
        vector.accumulated_work_decimal,
        "{}",
        vector.id
    );
    assert_eq!(
        accumulated.to_be_bytes(),
        decode_fixed_width_hex(&vector.accumulated_work_be_hex)?,
        "{}",
        vector.id
    );

    Ok(())
}

fn assert_invalid_target_vector(
    vector: &InvalidTargetVector,
) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = decode_hex(&vector.assigned_target_be_hex)?;
    let result = AssignedTarget::try_from(bytes.as_slice());

    match vector.expected_error {
        TargetErrorCode::InvalidTargetLength => {
            assert_eq!(result, Err(WorkError::InvalidTargetLength), "{}", vector.id)
        }
        TargetErrorCode::ZeroTarget => {
            assert_eq!(result, Err(WorkError::ZeroTarget), "{}", vector.id)
        }
    }

    Ok(())
}

fn assert_invalid_accumulation_vector(
    vector: &InvalidAccumulationVector,
) -> Result<(), Box<dyn std::error::Error>> {
    let result = accumulate_decimal_inputs(&vector.credited_work_inputs_decimal);

    match vector.expected_error {
        AccumulationErrorCode::CreditedWorkOverflow => {
            assert_eq!(
                result,
                Err(VectorAccumulationError::Work(
                    WorkError::CreditedWorkOverflow
                )),
                "{}",
                vector.id
            )
        }
    }

    Ok(())
}

fn accumulate_decimal_inputs(inputs: &[String]) -> Result<CreditedWork, VectorAccumulationError> {
    let mut inputs = inputs.iter();
    let Some(first) = inputs.next() else {
        return Err(VectorAccumulationError::MissingInputs);
    };
    let mut accumulated = CreditedWork::try_from(first.clone())?;
    for input in inputs {
        accumulated = accumulated.checked_add(CreditedWork::try_from(input.clone())?)?;
    }

    Ok(accumulated)
}

fn decode_fixed_width_hex(value: &str) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let bytes = decode_hex(value)?;
    <[u8; 32]>::try_from(bytes).map_err(|_| {
        Error::new(ErrorKind::InvalidData, "value must encode exactly 32 bytes").into()
    })
}

fn decode_hex(value: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if !value.is_ascii() || !value.len().is_multiple_of(2) {
        return Err(
            Error::new(ErrorKind::InvalidData, "hex must contain whole ASCII bytes").into(),
        );
    }

    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).map_err(Into::into))
        .collect()
}
