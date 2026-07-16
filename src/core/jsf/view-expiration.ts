export interface ResponseStatus {
  status: number;
  contentType: string;
  body: string;
}

export class JsfRecoverableStateError extends Error {
  readonly code: "VIEW_EXPIRED" | "STATE_MISMATCH";

  constructor(code: JsfRecoverableStateError["code"], message: string) {
    super(message);
    this.name = "JsfRecoverableStateError";
    this.code = code;
  }
}

export class JsfViewRecoveryExhaustedError extends Error {
  readonly code = "VIEW_RECOVERY_EXHAUSTED";
  readonly cause: JsfRecoverableStateError;

  constructor(cause: JsfRecoverableStateError) {
    super("El estado JSF volvió a expirar después del único ciclo de recuperación permitido", {
      cause,
    });
    this.name = "JsfViewRecoveryExhaustedError";
    this.cause = cause;
  }
}

function isXmlContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/xml" || mediaType === "application/xml";
}

export function isObservedViewExpiration(response: ResponseStatus): boolean {
  return (
    response.status === 500 && isXmlContentType(response.contentType) && response.body.trim() === ""
  );
}

export async function withViewRecovery<T>(
  operation: () => Promise<T>,
  recover: () => Promise<void>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof JsfRecoverableStateError)) throw error;
    await recover();
  }

  try {
    return await operation();
  } catch (error) {
    if (error instanceof JsfRecoverableStateError) {
      throw new JsfViewRecoveryExhaustedError(error);
    }
    throw error;
  }
}
