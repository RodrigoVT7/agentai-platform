// src/functions/auth/OtpVerifier.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { OtpVerifierHandler } from "../../shared/handlers/auth/otpVerifierHandler";
import { OtpVerifierValidator } from "../../shared/validators/auth/otpVerifierValidator";

export async function OtpVerifier(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    context.log.error("Error en verificación de OTP:", error);
    
    return {
      status: error.statusCode || 500,
      jsonBody: { error: error.message || "Error interno del servidor" }
    };
  }
}

app.http('OtpVerifier', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/verify-otp',
  handler: OtpVerifier
});