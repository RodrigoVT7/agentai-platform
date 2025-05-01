// src/shared/utils/error.utils.ts

export interface AppError {
  statusCode: number;
  message: string;
  details?: any;
}

/**
 * Crea un error de aplicación estandarizado
 */
export function createAppError(
  statusCode: number,
  message: string,
  details?: any
): AppError {
  return { statusCode, message, details };
}

/**
 * Verifica si un objeto es un AppError
 */
export function isAppError(error: unknown): error is AppError {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "message" in error &&
    typeof (error as AppError).statusCode === "number" &&
    typeof (error as AppError).message === "string"
  );
}

/**
 * Convierte cualquier error a un AppError
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return createAppError(500, error.message, { stack: error.stack });
  }

  return createAppError(500, "Error interno del servidor", {
    originalError: error,
  });
}

/**
 * Convierte errores específicos a AppError con código adecuado
 * Por ejemplo, errores de Azure Storage tienen códigos específicos
 */
export function handleStorageError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    // Intentar detectar errores específicos de Azure Storage
    const errorCode = (error as any).statusCode || (error as any).code;
    if (errorCode === 404 || errorCode === "ResourceNotFound") {
      return createAppError(404, "Recurso no encontrado", {
        originalError: error.message,
      });
    }

    if (errorCode === 409 || errorCode === "EntityAlreadyExists") {
      return createAppError(409, "El recurso ya existe", {
        originalError: error.message,
      });
    }

    return createAppError(500, error.message, { stack: error.stack });
  }

  return createAppError(500, "Error interno del servidor", {
    originalError: error,
  });
}
