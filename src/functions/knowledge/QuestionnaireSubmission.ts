import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import {
  QuestionnaireSubmissionCreateRequest,
  QuestionnaireSubmissionUpdateRequest,
  QuestionnaireSubmissionSearchParams,
} from "../../shared/models/questionnaireSubmission.model";
import { QuestionnaireSubmissionHandler } from "../../shared/handlers/knowledge/questionnaireSubmissionHandler";

/**
 * Main function to handle CRUD operations for questionnaire submissions
 * Supports JWT authentication and data validation
 */
export async function QuestionnaireSubmission(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // JWT token authentication verification
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        status: 401,
        jsonBody: { error: "Authentication required" },
      };
    }

    const token = authHeader.substring(7);
    let userId: string;

    try {
      const jwtService = new JwtService();
      const decodedToken = jwtService.verifyToken(token);
      userId = decodedToken.userId;
    } catch (error) {
      return {
        status: 401,
        jsonBody: { error: "Invalid or expired token" },
      };
    }

    // Execute requested CRUD operation
    const handler = new QuestionnaireSubmissionHandler();
    const method = request.method;

    // El ID puede venir en el formato "userId__agentId" o solo "agentId"
    const id = request.params.id;

    // Questionnaire data processing
    let questionnaireData:
      | QuestionnaireSubmissionCreateRequest
      | QuestionnaireSubmissionUpdateRequest
      | QuestionnaireSubmissionSearchParams
      | Record<string, never> = {};
    if (method === "POST" || method === "PUT") {
      questionnaireData = (await request.json()) as
        | QuestionnaireSubmissionCreateRequest
        | QuestionnaireSubmissionUpdateRequest;

      // Para creación, asegurarse de establecer el userId del token
      if (method === "POST") {
        (questionnaireData as QuestionnaireSubmissionCreateRequest).userId =
          userId;
      }
    } else if (method === "GET" && !id) {
      // Para listado (GET sin ID), agregar userId como filtro por defecto
      questionnaireData = { userId } as QuestionnaireSubmissionSearchParams;
    }

    const result = await handler.execute(questionnaireData, method, id);

    return {
      status: 200,
      jsonBody: result,
    };
  } catch (error) {
    // Centralized error handling
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details },
    };
  }
}

// HTTP endpoint configuration
app.http("QuestionnaireSubmission", {
  methods: ["GET", "POST", "PUT", "DELETE"],
  authLevel: "anonymous",
  route: "knowledge/questionnaire-submissions/{id?}",
  handler: QuestionnaireSubmission,
});
