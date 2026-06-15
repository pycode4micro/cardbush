type LocalImageReference = {
  path?: string;
};

type AllowedResourcePathRequest = {
  projectDir?: string;
  images?: LocalImageReference[];
  files?: string[];
};

export function applyAllowedResourcePathsToMetadata(
  metadata: Record<string, unknown>,
  request: AllowedResourcePathRequest,
) {
  const paths = collectAllowedResourcePaths(request);
  if (paths.length === 0) {
    return;
  }
  metadata.image_allowed_paths = paths;
  metadata.imageAllowedPaths = paths;
  metadata._resource_manager_allowed_paths = paths;
  metadata.resourceManagerAllowedPaths = paths;
}

export function collectAllowedResourcePaths(request: AllowedResourcePathRequest) {
  const roots: string[] = [];
  addAllowedRoot(roots, request.projectDir);
  for (const image of request.images ?? []) {
    addAllowedRoot(roots, localPathParent(image.path));
  }
  for (const file of request.files ?? []) {
    addAllowedRoot(roots, localPathParent(file));
  }
  return roots;
}

function addAllowedRoot(roots: string[], value?: string) {
  const normalized = normalizeLocalPath(value);
  if (!normalized || !isAbsoluteLocalPath(normalized)) {
    return;
  }
  const comparable = normalized.replaceAll('\\', '/').toLowerCase();
  if (roots.some((item) => item.replaceAll('\\', '/').toLowerCase() === comparable)) {
    return;
  }
  roots.push(normalized);
}

export function localPathParent(value?: string) {
  const normalized = normalizeLocalPath(value);
  if (!normalized || !isAbsoluteLocalPath(normalized)) {
    return '';
  }
  const trimmed = trimTrailingPathSeparator(normalized);
  const separatorIndex = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (separatorIndex < 0) {
    return trimmed;
  }
  if (/^[a-zA-Z]:[\\/]?$/i.test(trimmed.slice(0, separatorIndex + 1))) {
    return trimmed.slice(0, separatorIndex + 1);
  }
  if (separatorIndex <= 1 && trimmed.startsWith('/')) {
    return '/';
  }
  return trimmed.slice(0, separatorIndex);
}

function normalizeLocalPath(value?: string) {
  let normalized = String(value ?? '').trim();
  if (!normalized) {
    return '';
  }
  normalized = stripWrappingQuotes(normalized);
  if (/^file:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      const hostPrefix = parsed.hostname ? `//${parsed.hostname}` : '';
      return decodeURIComponent(`${hostPrefix}${parsed.pathname}`);
    } catch {
      return normalized;
    }
  }
  return normalized;
}

function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === '`' && last === '`')
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function trimTrailingPathSeparator(value: string) {
  if (/^[a-zA-Z]:[\\/]?$/i.test(value) || value === '/') {
    return value;
  }
  return value.replace(/[\\/]+$/g, '');
}

function isAbsoluteLocalPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//') || value.startsWith('/');
}
