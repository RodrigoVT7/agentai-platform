import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { QuestionnaireSubmissionCreateRequest } from "../../shared/models/questionnaireSubmission.model";
import { QuestionnaireSubmissionValidator } from "../../shared/validators/knowledge/questionnaireSubmissionValidator";
import { QuestionnaireSubmissionHandler } from "../../shared/handlers/knowledge/questionnaireSubmissionHandler";

export async function QuestionnaireSubmission(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  logger.info(
    `Iniciando procesamiento de solicitud ${request.method} para questionnaire submission`
  );

  try {
    // Auth Verification
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.warn("Intento de acceso sin token de autenticación");
      return {
        status: 401,
        jsonBody: { error: "Se requiere autenticación" },
      };
    }

    const token = authHeader.substring(7);
    let userId: string;

    try {
      const jwtService = new JwtService();
      const decodedToken = jwtService.verifyToken(token);
      userId = decodedToken.userId;
      logger.info(`Usuario autenticado: ${userId}`);
    } catch (error) {
      logger.warn("Token inválido o expirado", { error });
      return {
        status: 401,
        jsonBody: { error: "Token inválido o expirado" },
      };
    }

    // Obtener los datos del cuerpo
    const questionnaireData =
      (await request.json()) as QuestionnaireSubmissionCreateRequest;
    logger.info("Datos del cuestionario recibidos", {
      agentId: questionnaireData.agentId,
      method: request.method,
      id: request.params.id,
    });

    // Validar entrada
    const validator = new QuestionnaireSubmissionValidator();
    const validationResult = await validator.validateCreate(
      questionnaireData,
      userId
    );

    if (!validationResult.isValid) {
      logger.warn("Validación fallida", { errors: validationResult.errors });
      return {
        status: 400,
        jsonBody: {
          error: "Datos inválidos",
          details: validationResult.errors,
        },
      };
    }

    // Procesar solicitud
    const handler = new QuestionnaireSubmissionHandler();
    const method = request.method;
    const id = request.params.id;
    logger.info("Iniciando procesamiento de solicitud", { method, id });

    const result = await handler.execute(questionnaireData, method, id);
    logger.info("Solicitud procesada exitosamente");

    return {
      status: 200,
      jsonBody: result,
    };
  } catch (error) {
    logger.error("Error en gestión de cuestionarios:", error);

    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details },
    };
  }
}

app.http("QuestionnaireSubmission", {
  methods: ["GET", "POST", "PUT", "DELETE"],
  authLevel: "anonymous",
  route: "knowledge/questionnaire-submissions/{id?}",
  handler: QuestionnaireSubmission,
});
