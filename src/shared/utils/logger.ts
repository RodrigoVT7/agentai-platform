// src/shared/utils/logger.ts
import { InvocationContext } from "@azure/functions";

/**
 * Interfaz de Logger para uso consistente
 */
export interface Logger {
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, data?: any): void;
  debug(message: string, data?: any): void;
}

/**
 * Logger para Azure Functions
 */
export class AzureFunctionLogger implements Logger {
  private context: InvocationContext;
  
  constructor(context: InvocationContext) {
    this.context = context;
  }
  
  info(message: string, data?: any): void {
    if (data) {
      this.context.log(`[INFO] ${message}`, data);
    } else {
      this.context.log(`[INFO] ${message}`);
    }
  }
  
  warn(message: string, data?: any): void {
    if (data) {
      this.context.log(`[WARN] ${message}`, data);
    } else {
      this.context.log(`[WARN] ${message}`);
    }
  }
  
  error(message: string, data?: any): void {
    if (data) {
      this.context.log(`[ERROR] ${message}`, data);
    } else {
      this.context.log(`[ERROR] ${message}`);
    }
  }
  
  debug(message: string, data?: any): void {
    if (data) {
      this.context.log(`[DEBUG] ${message}`, data);
    } else {
      this.context.log(`[DEBUG] ${message}`);
    }
  }
}

/**
 * Logger para entornos no-Azure (consola)
 */
export class ConsoleLogger implements Logger {
  info(message: string, data?: any): void {
    if (data) {
      console.log(`[INFO] ${message}`, data);
    } else {
      console.log(`[INFO] ${message}`);
    }
  }
  
  warn(message: string, data?: any): void {
    if (data) {
      console.warn(`[WARN] ${message}`, data);
    } else {
      console.warn(`[WARN] ${message}`);
    }
  }
  
  error(message: string, data?: any): void {
    if (data) {
      console.error(`[ERROR] ${message}`, data);
    } else {
      console.error(`[ERROR] ${message}`);
    }
  }
  
  debug(message: string, data?: any): void {
    if (data) {
      console.debug(`[DEBUG] ${message}`, data);
    } else {
      console.debug(`[DEBUG] ${message}`);
    }
  }
}

/**
 * Crea un logger para el contexto actual
 */
export function createLogger(context?: InvocationContext): Logger {
  if (context) {
    return new AzureFunctionLogger(context);
  }
  return new ConsoleLogger();
}