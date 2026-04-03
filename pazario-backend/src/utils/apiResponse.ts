// src/utils/apiResponse.ts

export interface ApiResponse<T = any> {
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
  static success<T>(data: T, message?: string): ApiResponse<T> {
    return {
      success: true,
      data,
      timestamp: new Date().toISOString()
    }
  }

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
      timestamp: new Date().toISOString()
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
      timestamp: new Date().toISOString()
    }
  }
}

// Global error handler middleware
export const errorHandler = (
  err: any,
  req: any,
  res: any,
  next: any
) => {
  const status = err.status || err.statusCode || 500
  const message = err.message || 'Internal Server Error'
  const code = err.code || 'INTERNAL_ERROR'

  const response = ApiResponseBuilder.error(message, code)

  res.status(status).json(response)
}
