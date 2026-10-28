import { api } from '../api/client'

export async function getLocalSyncStatus<T>() {
  const response = await api.get<{ data: T }>('/local-sync/status')
  return response.data.data
}

export async function getLocalSyncSources<T>() {
  const response = await api.get<{ data: T }>('/local-sync/xml-sources')
  return response.data.data
}
