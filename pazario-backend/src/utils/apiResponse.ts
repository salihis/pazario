// src/utils/apiResponse.ts

import { ErrorRequestHandler } from 'express'

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  code?: string
  timestamp: string
}

export interface ValidationError {
  field: string
  message: string
}

export interface ApiErrorResponse {
  success: false
  error: string
  code: string
  details?: ValidationError[]
  timestamp: string
}

export class ApiResponseBuilder {
  /** Başarılı yanıt oluşturur */
  static success<T>(data: T): ApiResponse<T> {
    return {
      success: true,
      data,
      timestamp: new Date().toISOString(),
    }
  }

  /** Hata yanıtı oluşturur */
  static error(
    error: string,
    code: string = 'INTERNAL_ERROR',
    details?: ValidationError[]
  ): ApiErrorResponse {
    return {
      success: false,
      error,
      code,
      details,
      timestamp: new Date().toISOString(),
    }
  }

  static notFound(resource: string): ApiErrorResponse {
    return this.error(`${resource} not found`, 'NOT_FOUND')
  }

  static badRequest(error: string): ApiErrorResponse {
    return this.error(error, 'BAD_REQUEST')
  }

  static unauthorized(): ApiErrorResponse {
    return this.error('Unauthorized', 'UNAUTHORIZED')
  }

  static forbidden(): ApiErrorResponse {
    return this.error('Forbidden', 'FORBIDDEN')
  }

  static validationError(details: ValidationError[]): ApiErrorResponse {
    return {
      success: false,
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details,
      timestamp: new Date().toISOString(),
    }
  }
}

/** Global Express hata handler middleware */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status: number =
    typeof err.status === 'number'
      ? err.status
      : typeof err.statusCode === 'number'
        ? err.statusCode
        : 500
  const message: string = typeof err.message === 'string' ? err.message : 'Internal Server Error'
  const code: string = typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR'

  res.status(status).json(ApiResponseBuilder.error(message, code))
}
