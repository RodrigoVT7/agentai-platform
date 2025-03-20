// src/functions/auth/OtpVerifier.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { OtpVerifierHandler } from "../../shared/handlers/auth/otpVerifierHandler";
import { OtpVerifierValidator } from "../../shared/validators/auth/otpVerifierValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";

export async function OtpVerifier(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  
  try {
    // Obtener los datos del cuerpo
    const otpData = await request.json();
    
    // Validar entrada
    const validator = new OtpVerifierValidator();
    const validationResult = validator.validate(otpData);
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }
    
    // Procesar solicitud
    const handler = new OtpVerifierHandler();
    const result = await handler.execute(otpData);
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error en verificación de OTP:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('OtpVerifier', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/verify-otp',
  handler: OtpVerifier
});