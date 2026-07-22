export function applyDistortionHorizontalOffset(dataList: any[]): any[] {
  return (Array.isArray(dataList) ? dataList : []).map((data) => {
    const distortionValues = Array.isArray(data?.distortionPercent) ? data.distortionPercent : [];
    const fieldValues = Array.isArray(data?.fieldValues) ? data.fieldValues : [];
    const count = Math.min(distortionValues.length, fieldValues.length);
    if (count <= 0) return data;

    const finitePairs: Array<{ field: number; distortion: number }> = [];
    for (let index = 0; index < count; index++) {
      const field = Number(fieldValues[index]);
      const distortion = Number(distortionValues[index]);
      if (!Number.isFinite(field) || !Number.isFinite(distortion)) continue;
      finitePairs.push({ field, distortion });
    }
    if (finitePairs.length === 0) return data;

    finitePairs.sort((left, right) => left.field - right.field);
    const positivePairs = finitePairs.filter((pair) => pair.field > 1e-12);
    const first = positivePairs[0] || null;
    const second = positivePairs[1] || null;

    let offset: number | null = null;
    if (first && second) {
      const fieldDelta = second.field - first.field;
      offset = Math.abs(fieldDelta) > 1e-15
        ? first.distortion + ((0 - first.field) * (second.distortion - first.distortion)) / fieldDelta
        : first.distortion;
    } else if (first) {
      offset = first.distortion;
    }
    if (!Number.isFinite(offset)) return data;

    const shiftedValues = distortionValues.map((rawValue: any) => {
      const value = Number(rawValue);
      return Number.isFinite(value) ? value - Number(offset) : null;
    });

    const shiftedPairs = [] as Array<{ field: number; distortion: number }>;
    for (let index = 0; index < count; index++) {
      const field = Number(fieldValues[index]);
      const distortion = Number(shiftedValues[index]);
      if (!Number.isFinite(field) || !Number.isFinite(distortion) || field <= 1e-12) continue;
      shiftedPairs.push({ field, distortion });
    }
    shiftedPairs.sort((left, right) => left.field - right.field);

    const shiftedFirst = shiftedPairs[0] || null;
    const shiftedSecond = shiftedPairs[1] || null;
    let residualIntercept = 0;
    if (shiftedFirst && shiftedSecond) {
      const fieldDelta = shiftedSecond.field - shiftedFirst.field;
      residualIntercept = Math.abs(fieldDelta) > 1e-15
        ? shiftedFirst.distortion
          + ((0 - shiftedFirst.field) * (shiftedSecond.distortion - shiftedFirst.distortion)) / fieldDelta
        : shiftedFirst.distortion;
    } else if (shiftedFirst) {
      residualIntercept = shiftedFirst.distortion;
    }
    if (!Number.isFinite(residualIntercept)) residualIntercept = 0;

    const correctedValues = shiftedValues.map((rawValue: any, index: number) => {
      const field = Number(fieldValues[index]);
      if (Number.isFinite(field) && Math.abs(field) <= 1e-12) return 0;
      const value = Number(rawValue);
      return Number.isFinite(value) ? value - residualIntercept : null;
    });

    return {
      ...data,
      distortionPercent: correctedValues,
      fieldValues,
      meta: {
        ...(data?.meta || {}),
        distortionHorizontalOffsetPercent: offset,
        distortionHorizontalOffsetResidualPercent: residualIntercept,
        distortionOffsetBasis: 'line-through-two-smallest-positive-ih-to-ih0',
        distortionOffsetPoint1IH: first?.field ?? null,
        distortionOffsetPoint1DistPercent: first?.distortion ?? null,
        distortionOffsetPoint2IH: second?.field ?? null,
        distortionOffsetPoint2DistPercent: second?.distortion ?? null,
        ih0ForcedZeroAfterOffset: true,
      },
    };
  });
}