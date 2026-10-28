import {
  Marketplace,
  OperationItemStatus,
  OperationStatus,
  OperationType,
  Prisma,
  PrismaClient,
} from '@prisma/client'
import { orderFetchQueue, publishQueue, syncQueue } from '../queue/queues'

type RetryQueueName = 'publish' | 'sync' | 'order-fetch'

type RetryPayload = {
  queueName: RetryQueueName
  jobName: string
  data: Record<string, unknown>
}

type CreateOperationInput = {
  type: OperationType
  title: string
  marketplace?: Marketplace | null
  queueName?: string | null
  queueJobId?: string | null
  requestedBy?: string | null
  sourceId?: string | null
  syncJobId?: string | null
  productPublishJobId?: string | null
  targetCount?: number
  metadata?: Prisma.InputJsonValue
  retryPayload?: RetryPayload | null
}

type CreateOperationItemInput = {
  productId?: string | null
  sku?: string | null
  barcode?: string | null
  variantGroupKey?: string | null
  status?: OperationItemStatus
  metadata?: Prisma.InputJsonValue
}

const TERMINAL_STATUSES: OperationStatus[] = ['SUCCEEDED', 'FAILED', 'PARTIALLY_FAILED']

export class OperationHistoryService {
  constructor(private readonly prisma: PrismaClient) {}

  async createOperation(input: CreateOperationInput, items: CreateOperationItemInput[] = []) {
    return this.prisma.operationHistory.create({
      data: {
        type: input.type,
        title: input.title,
        marketplace: input.marketplace ?? undefined,
        queueName: input.queueName ?? undefined,
        queueJobId: input.queueJobId ?? undefined,
        requestedBy: input.requestedBy ?? undefined,
        sourceId: input.sourceId ?? undefined,
        syncJobId: input.syncJobId ?? undefined,
        productPublishJobId: input.productPublishJobId ?? undefined,
        targetCount: input.targetCount ?? items.length,
        metadata: input.metadata ?? {},
        retryPayload: input.retryPayload ? input.retryPayload as Prisma.InputJsonValue : undefined,
        items: items.length
          ? {
              create: items.map(item => ({
                productId: item.productId ?? undefined,
                sku: item.sku ?? undefined,
                barcode: item.barcode ?? undefined,
                variantGroupKey: item.variantGroupKey ?? undefined,
                status: item.status ?? 'QUEUED',
                metadata: item.metadata ?? {},
              })),
            }
          : undefined,
      },
      include: { items: true },
    })
  }

  async markRunning(id: string, data: { queueJobId?: string | number | null; metadata?: Prisma.InputJsonValue } = {}) {
    return this.prisma.operationHistory.update({
      where: { id },
      data: {
        status: 'RUNNING',
        queueJobId: data.queueJobId === undefined || data.queueJobId === null ? undefined : String(data.queueJobId),
        metadata: data.metadata ?? undefined,
        startedAt: new Date(),
      },
    })
  }

  async markWaitingMarketplace(id: string, externalBatchId: string | null | undefined, message?: string) {
    return this.prisma.operationHistory.update({
      where: { id },
      data: {
        status: 'WAITING_MARKETPLACE',
        externalBatchId: externalBatchId ?? undefined,
        errorMessage: message ?? undefined,
      },
    })
  }

  async markFinished(
    id: string,
    status: Extract<OperationStatus, 'SUCCEEDED' | 'FAILED' | 'PARTIALLY_FAILED'>,
    data: {
      externalBatchId?: string | null
      errorMessage?: string | null
      metadata?: Prisma.InputJsonValue
      successCount?: number
      failedCount?: number
      skippedCount?: number
    } = {}
  ) {
    return this.prisma.operationHistory.update({
      where: { id },
      data: {
        status,
        externalBatchId: data.externalBatchId ?? undefined,
        errorMessage: data.errorMessage ?? undefined,
        metadata: data.metadata ?? undefined,
        successCount: data.successCount ?? undefined,
        failedCount: data.failedCount ?? undefined,
        skippedCount: data.skippedCount ?? undefined,
        finishedAt: new Date(),
      },
    })
  }

  async updateItemsByProductIds(
    operationId: string,
    productIds: string[],
    status: OperationItemStatus,
    data: { externalListingId?: string | null; externalBatchId?: string | null; errorMessage?: string | null } = {}
  ) {
    if (productIds.length === 0) return { count: 0 }
    const now = new Date()
    return this.prisma.operationItem.updateMany({
      where: { operationId, productId: { in: productIds } },
      data: {
        status,
        externalListingId: data.externalListingId ?? undefined,
        externalBatchId: data.externalBatchId ?? undefined,
        errorMessage: data.errorMessage ?? undefined,
        startedAt: status === 'RUNNING' ? now : undefined,
        finishedAt: ['SUCCEEDED', 'FAILED', 'SKIPPED'].includes(status) ? now : undefined,
      },
    })
  }

  async listOperations(params: {
    type?: OperationType
    status?: OperationStatus
    marketplace?: Marketplace
    page: number
    limit: number
  }) {
    const where: Prisma.OperationHistoryWhereInput = {
      ...(params.type ? { type: params.type } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.marketplace ? { marketplace: params.marketplace } : {}),
    }
    const skip = (params.page - 1) * params.limit
    const [data, total] = await Promise.all([
      this.prisma.operationHistory.findMany({
        where,
        skip,
        take: params.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { items: true } },
        },
      }),
      this.prisma.operationHistory.count({ where }),
    ])
    return { data, meta: { total, page: params.page, limit: params.limit } }
  }

  async getOperation(id: string) {
    return this.prisma.operationHistory.findUnique({
      where: { id },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            product: { select: { id: true, sku: true, title: true, images: true } },
          },
        },
      },
    })
  }

  async retryOperation(id: string, requestedBy?: string | null) {
    const operation = await this.prisma.operationHistory.findUnique({
      where: { id },
      include: { items: true },
    })
    if (!operation) throw new Error('Operation not found')
    if (!TERMINAL_STATUSES.includes(operation.status)) {
      throw new Error('Only completed or failed operations can be retried')
    }
    if (operation.retryCount >= operation.maxRetryCount) {
      throw new Error('Maximum retry count reached')
    }
    let retryPayload = this.parseRetryPayload(operation.retryPayload)
    if (!retryPayload) throw new Error('This operation does not have a retry payload')

    const retryItems = retryPayload.queueName === 'publish'
      ? operation.items.filter(item => item.status === 'FAILED' && item.productId)
      : operation.items
    if (retryPayload.queueName === 'publish' && retryItems.length === 0) {
      throw new Error('Tekrar denenecek basarisiz urun yok')
    }

    if (retryPayload.queueName === 'publish') {
      if (!operation.marketplace) throw new Error('Pazaryeri bilgisi eksik')
      const productIds = retryItems.map(item => item.productId).filter(Boolean) as string[]
      const publishJobs = await Promise.all(productIds.map(productId =>
        this.prisma.productPublishJob.create({
          data: {
            productId,
            marketplace: operation.marketplace!,
            status: 'QUEUED',
            triggeredBy: requestedBy ?? undefined,
            submittedAt: new Date(),
          },
        })
      ))
      retryPayload = {
        ...retryPayload,
        data: {
          ...retryPayload.data,
          productId: productIds[0],
          productIds: productIds.length > 1 ? productIds : undefined,
          publishJobId: publishJobs[0]?.id,
          publishJobIds: publishJobs.length > 1 ? publishJobs.map(job => job.id) : undefined,
        },
      }
    }

    const retryOperation = await this.createOperation({
      type: operation.type,
      title: `${operation.title} (retry ${operation.retryCount + 1})`,
      marketplace: operation.marketplace,
      queueName: retryPayload.queueName,
      requestedBy,
      sourceId: operation.sourceId,
      targetCount: retryPayload.queueName === 'publish' ? retryItems.length : operation.targetCount,
      metadata: {
        retryOfOperationId: operation.id,
      },
      retryPayload,
    }, retryItems.map(item => ({
      productId: item.productId,
      sku: item.sku,
      barcode: item.barcode,
      variantGroupKey: item.variantGroupKey,
      status: 'QUEUED',
      metadata: item.metadata as Prisma.InputJsonValue,
    })))

    const data = {
      ...retryPayload.data,
      operationId: retryOperation.id,
    }

    const queue = retryPayload.queueName === 'publish'
      ? publishQueue
      : retryPayload.queueName === 'sync'
        ? syncQueue
        : orderFetchQueue

    const job = await queue.add(retryPayload.jobName, data)
    await this.prisma.operationHistory.update({
      where: { id: retryOperation.id },
      data: { queueJobId: String(job.id) },
    })
    await this.prisma.operationHistory.update({
      where: { id: operation.id },
      data: { retryCount: { increment: 1 } },
    })

    return retryOperation
  }

  private parseRetryPayload(value: Prisma.JsonValue | null): RetryPayload | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const payload = value as Record<string, unknown>
    const queueName = payload.queueName
    const jobName = payload.jobName
    const data = payload.data
    if (queueName !== 'publish' && queueName !== 'sync' && queueName !== 'order-fetch') return null
    if (typeof jobName !== 'string' || !jobName) return null
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return { queueName, jobName, data: data as Record<string, unknown> }
  }
}
