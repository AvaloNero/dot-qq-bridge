// Local waiting limits, not a statement about the QQ server's QR lifetime.
export const QR_LOCAL_WAIT_MS = 600000;
export const QR_WORKER_MAX_MS = QR_LOCAL_WAIT_MS + 15000;
export const QR_PARENT_MAX_MS = QR_WORKER_MAX_MS + 5000;
export const QR_PROBE_MAX_MS = 60000;
export const QR_REQUEST_BUDGET = Math.ceil(QR_LOCAL_WAIT_MS / 2000) + 5;

export const QR_REQUEST_TIMEOUT_MS = 30000;
