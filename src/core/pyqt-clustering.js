const FEATURE_COUNT = 8;
const DEFAULT_CLUSTERS = 3;
const DEFAULT_RESTARTS = 10;
const DEFAULT_MAX_ITERATIONS = 300;

function pyqtFeatureHasValue(value, field) {
  if (!value || value === "Unknown") return false;
  return field !== "room" || value !== "Не указано";
}

/** Matches the numeric feature projection used by PyQt's StandardScaler/KMeans dialog. */
export function pyqtDeviceFeatures(device = {}) {
  const mac = String(device.mac ?? device.macFormatted ?? device.mac_formatted ?? "");
  const vendor = String(device.vendor ?? device.manufacturer ?? "");
  const model = String(device.model ?? "");
  const address = String(device.address ?? device.physicalAddress ?? "");
  return [
    mac.length,
    vendor.length,
    model.length,
    address.length,
    Number(pyqtFeatureHasValue(device.ip, "ip")),
    Number(pyqtFeatureHasValue(device.room, "room")),
    Number(pyqtFeatureHasValue(device.switchIp ?? device.switch_ip, "switchIp")),
    Number(pyqtFeatureHasValue(device.switchPort ?? device.switch_port, "switchPort")),
  ];
}

/** Write directly into the bounded numeric feature buffer without allocating one row per device. */
export function writePyqtDeviceFeatures(device = {}, target, offset = 0) {
  if (!target || typeof target.length !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset + FEATURE_COUNT > target.length) {
    throw new RangeError("Буфер признаков должен содержать восемь свободных позиций");
  }
  const mac = String(device.mac ?? device.macFormatted ?? device.mac_formatted ?? "");
  const vendor = String(device.vendor ?? device.manufacturer ?? "");
  const model = String(device.model ?? "");
  const address = String(device.address ?? device.physicalAddress ?? "");
  target[offset] = mac.length;
  target[offset + 1] = vendor.length;
  target[offset + 2] = model.length;
  target[offset + 3] = address.length;
  target[offset + 4] = Number(pyqtFeatureHasValue(device.ip, "ip"));
  target[offset + 5] = Number(pyqtFeatureHasValue(device.room, "room"));
  target[offset + 6] = Number(pyqtFeatureHasValue(device.switchIp ?? device.switch_ip, "switchIp"));
  target[offset + 7] = Number(pyqtFeatureHasValue(device.switchPort ?? device.switch_port, "switchPort"));
}

/** Drop empty KMeans groups and remap observed labels to the compact PyQt result list. */
export function compactPyqtClusterLabels(labels) {
  if (!(labels instanceof Uint8Array) && !(labels instanceof Uint16Array) && !(labels instanceof Uint32Array)) {
    throw new TypeError("Метки кластеров должны быть целочисленным типизированным массивом");
  }
  const remap = new Map();
  for (const label of labels) if (!remap.has(label)) remap.set(label, remap.size);
  const compacted = new Uint8Array(labels.length);
  for (let index = 0; index < labels.length; index += 1) compacted[index] = remap.get(labels[index]);
  return { labels: compacted, clusterCount: remap.size };
}

function createNumpyRandomState(seed) {
  // PyQt uses random_state=42, which scikit-learn passes to NumPy's legacy
  // MT19937 RandomState generator for K-means++ initialization.
  const state = new Uint32Array(624);
  state[0] = Number(seed) >>> 0;
  for (let index = 1; index < state.length; index += 1) {
    const previous = state[index - 1];
    state[index] = (Math.imul(1812433253, previous ^ (previous >>> 30)) + index) >>> 0;
  }
  let position = state.length;
  const nextUint32 = () => {
    if (position >= state.length) {
      for (let index = 0; index < state.length; index += 1) {
        const joined = (state[index] & 0x80000000) | (state[(index + 1) % state.length] & 0x7fffffff);
        state[index] = (state[(index + 397) % state.length] ^ (joined >>> 1) ^ ((joined & 1) ? 0x9908b0df : 0)) >>> 0;
      }
      position = 0;
    }
    let value = state[position++];
    value ^= value >>> 11;
    value ^= (value << 7) & 0x9d2c5680;
    value ^= (value << 15) & 0xefc60000;
    value ^= value >>> 18;
    return value >>> 0;
  };
  return {
    random() {
      const high = nextUint32() >>> 5;
      const low = nextUint32() >>> 6;
      return (high * 67108864 + low) / 9007199254740992;
    },
    choice(size) {
      // NumPy's p=uniform choice path consumes one random double and selects
      // from the cumulative probability vector.
      return Math.min(size - 1, Math.floor(this.random() * size));
    },
  };
}

function squaredDistance(features, position, centers, centerOffset) {
  let distance = 0;
  const offset = position * FEATURE_COUNT;
  for (let field = 0; field < FEATURE_COUNT; field += 1) {
    const delta = features[offset + field] - centers[centerOffset + field];
    distance += delta * delta;
  }
  return distance;
}

/** Match scikit-learn's float64 ||X||² - 2 X·C + ||C||² distance path. */
function sklearnSquaredDistance(features, position, centers, centerOffset) {
  const offset = position * FEATURE_COUNT;
  let dot = 0;
  let pointNorm = 0;
  let centerNorm = 0;
  for (let field = 0; field < FEATURE_COUNT; field += 1) {
    const point = features[offset + field];
    const center = centers[centerOffset + field];
    dot += point * center;
    pointNorm += point * point;
    centerNorm += center * center;
  }
  return Math.max(0, (-2 * dot + centerNorm) + pointNorm);
}

/** sklearn Lloyd assignment keeps ||C||² - 2 X·C; ||X||² is label invariant. */
function sklearnAssignmentDistance(features, position, centers, centerOffset) {
  const offset = position * FEATURE_COUNT;
  let dot = 0;
  let centerNorm = 0;
  for (let field = 0; field < FEATURE_COUNT; field += 1) {
    const point = features[offset + field];
    const center = centers[centerOffset + field];
    dot += point * center;
    centerNorm += center * center;
  }
  return centerNorm - 2 * dot;
}

function initializeCenters(features, count, clusters, random) {
  // PyQt passes Python numeric rows through StandardScaler into sklearn's
  // float64 arrays. Keep centers at that precision to avoid changing distance
  // ties during assignment.
  const centers = new Float64Array(clusters * FEATURE_COUNT);
  const nearestDistance = new Float64Array(count);
  const first = random.choice(count);
  centers.set(features.subarray(first * FEATURE_COUNT, (first + 1) * FEATURE_COUNT), 0);
  for (let position = 0; position < count; position += 1) {
    nearestDistance[position] = sklearnSquaredDistance(features, position, centers, 0);
  }
  for (let cluster = 1; cluster < clusters; cluster += 1) {
    let totalDistance = 0;
    for (let position = 0; position < count; position += 1) totalDistance += nearestDistance[position];
    let selected = 0;
    if (totalDistance > 0 && Number.isFinite(totalDistance)) {
      let bestPotential = Number.POSITIVE_INFINITY;
      const localTrials = 2 + Math.floor(Math.log(clusters));
      const targets = Array.from({ length: localTrials }, () => random.random() * totalDistance);
      const candidates = targets.map((target) => {
        let cumulative = 0;
        let candidate = count - 1;
        for (let position = 0; position < count; position += 1) {
          cumulative += nearestDistance[position];
          if (cumulative >= target) { candidate = position; break; }
        }
        return candidate;
      });
      for (const candidate of candidates) {
        const candidateOffset = candidate * FEATURE_COUNT;
        let potential = 0;
        for (let position = 0; position < count; position += 1) {
          const distance = sklearnSquaredDistance(features, position, features, candidateOffset);
          potential += Math.min(nearestDistance[position], distance);
        }
        if (potential < bestPotential) { bestPotential = potential; selected = candidate; }
      }
    }
    const centerOffset = cluster * FEATURE_COUNT;
    centers.set(features.subarray(selected * FEATURE_COUNT, (selected + 1) * FEATURE_COUNT), centerOffset);
    for (let position = 0; position < count; position += 1) {
      const distance = sklearnSquaredDistance(features, position, centers, centerOffset);
      if (distance < nearestDistance[position]) nearestDistance[position] = distance;
    }
  }
  return centers;
}

function assignAndUpdate(features, count, centers, clusters, previousLabels = null) {
  const labels = new Uint8Array(count);
  const sums = new Float64Array(clusters * FEATURE_COUNT);
  const counts = new Uint32Array(clusters);
  let inertia = 0;
  let changed = false;
  for (let position = 0; position < count; position += 1) {
    let bestCluster = 0;
    let bestDistance = sklearnAssignmentDistance(features, position, centers, 0);
    for (let cluster = 1; cluster < clusters; cluster += 1) {
      const offset = cluster * FEATURE_COUNT;
      const distance = sklearnAssignmentDistance(features, position, centers, offset);
      if (distance < bestDistance) { bestDistance = distance; bestCluster = cluster; }
    }
    labels[position] = bestCluster;
    changed ||= previousLabels ? bestCluster !== previousLabels[position] : true;
    inertia += squaredDistance(features, position, centers, bestCluster * FEATURE_COUNT);
    counts[bestCluster] += 1;
    const sumOffset = bestCluster * FEATURE_COUNT;
    const featureOffset = position * FEATURE_COUNT;
    for (let field = 0; field < FEATURE_COUNT; field += 1) sums[sumOffset + field] += features[featureOffset + field];
  }
  for (let cluster = 0; cluster < clusters; cluster += 1) {
    if (!counts[cluster]) continue;
    const centerOffset = cluster * FEATURE_COUNT;
    for (let field = 0; field < FEATURE_COUNT; field += 1) centers[centerOffset + field] = sums[centerOffset + field] / counts[cluster];
  }
  return { labels, counts, inertia, changed };
}

async function fitOne(features, count, clusters, random, maxIterations, { signal, onProgress } = {}) {
  const centers = initializeCenters(features, count, clusters, random);
  let result;
  let previousLabels = null;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (signal?.aborted) throw new DOMException("Кластеризация отменена", "AbortError");
    result = assignAndUpdate(features, count, centers, clusters, previousLabels);
    if (previousLabels && !result.changed) break;
    previousLabels = result.labels;
    onProgress?.({ stage: "iteration", iteration: iteration + 1, clusters });
    if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
    else await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // Reassign against the final updated centers, matching the estimator's final labels.
  return assignAndUpdate(features, count, centers, clusters);
}

/** Standardize PyQt's eight device features and run deterministic multi-start Lloyd KMeans. */
export async function clusterPyqtFeatureRows(rows, {
  clusters = DEFAULT_CLUSTERS,
  restarts = DEFAULT_RESTARTS,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  seed = 42,
  signal,
  onProgress,
} = {}) {
  const flatInput = rows instanceof Float32Array || rows instanceof Float64Array;
  const count = flatInput ? Math.floor(rows.length / FEATURE_COUNT) : Array.isArray(rows) ? rows.length : 0;
  if (!count || (flatInput && rows.length % FEATURE_COUNT) || count < 3) return { status: "insufficient-data", labels: new Uint8Array(), clusterCount: 0, inertia: 0 };
  const clusterCount = Math.max(1, Math.min(3, Math.floor(Number(clusters) || DEFAULT_CLUSTERS), count));
  // StandardScaler returns float64 for the source's Python list of numbers.
  // Float32 rounding here can change nearest-center decisions and inertia.
  const normalizedRows = new Float64Array(count * FEATURE_COUNT);
  const means = new Float64Array(FEATURE_COUNT);
  const variances = new Float64Array(FEATURE_COUNT);
  for (let position = 0; position < count; position += 1) {
    const offset = position * FEATURE_COUNT;
    for (let field = 0; field < FEATURE_COUNT; field += 1) {
      const row = flatInput ? rows : rows[position];
      if (!row || (!flatInput && row.length < FEATURE_COUNT)) throw new TypeError(`Строка признаков ${position} должна содержать ${FEATURE_COUNT} значений`);
      const value = Number(flatInput ? row[offset + field] : row[field]);
      if (!Number.isFinite(value)) throw new TypeError(`Признак ${field} в строке ${position} должен быть конечным числом`);
      normalizedRows[offset + field] = value;
      means[field] += value;
    }
  }
  for (let field = 0; field < FEATURE_COUNT; field += 1) means[field] /= count;
  for (let position = 0; position < count; position += 1) {
    const offset = position * FEATURE_COUNT;
    for (let field = 0; field < FEATURE_COUNT; field += 1) {
      const delta = normalizedRows[offset + field] - means[field];
      variances[field] += delta * delta;
    }
  }
  const scales = new Float64Array(FEATURE_COUNT);
  for (let field = 0; field < FEATURE_COUNT; field += 1) scales[field] = Math.sqrt(variances[field] / count) || 1;
  for (let position = 0; position < count; position += 1) {
    const offset = position * FEATURE_COUNT;
    for (let field = 0; field < FEATURE_COUNT; field += 1) normalizedRows[offset + field] = (normalizedRows[offset + field] - means[field]) / scales[field];
  }
  let best = null;
  const restartCount = Math.max(1, Math.min(10, Math.floor(Number(restarts) || DEFAULT_RESTARTS)));
  const random = createNumpyRandomState(seed);
  for (let restart = 0; restart < restartCount; restart += 1) {
    onProgress?.({ stage: "restart", restart: restart + 1, restarts: restartCount, clusters: clusterCount });
    const result = await fitOne(normalizedRows, count, clusterCount, random, Math.max(1, Math.min(300, Math.floor(Number(maxIterations) || DEFAULT_MAX_ITERATIONS))), { signal, onProgress });
    if (!best || result.inertia < best.inertia) best = result;
  }
  return { status: "ok", labels: best.labels, clusterCount, inertia: best.inertia };
}
