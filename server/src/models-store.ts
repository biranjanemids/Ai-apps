import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import yaml from 'js-yaml'

export interface ModelConfig {
  id:           string
  provider:     string
  upstream:     string
  base_url?:    string
  api_key?:     string
  description?: string
}

class ModelsStore {
  private _path = ''
  private _models: ModelConfig[] = []

  load(modelsPath: string) {
    this._path = resolve(modelsPath)
    this._read()
  }

  private _read() {
    const raw  = readFileSync(this._path, 'utf-8')
    const data = yaml.load(raw) as { models: ModelConfig[] }
    this._models = data.models ?? []
  }

  list(): ModelConfig[] {
    return [...this._models]
  }

  get(id: string): ModelConfig | undefined {
    return this._models.find(m => m.id === id)
  }

  add(cfg: ModelConfig) {
    if (this._models.find(m => m.id === cfg.id)) {
      const err = new Error(`Model '${cfg.id}' already exists`) as any
      err.statusCode = 409
      throw err
    }
    this._models.push(cfg)
    this._write()
  }

  update(id: string, patch: Partial<Omit<ModelConfig, 'id'>>): ModelConfig {
    const idx = this._models.findIndex(m => m.id === id)
    if (idx === -1) {
      const err = new Error(`Model '${id}' not found`) as any
      err.statusCode = 404
      throw err
    }
    this._models[idx] = { ...this._models[idx], ...patch }
    this._write()
    return this._models[idx]
  }

  remove(id: string) {
    const idx = this._models.findIndex(m => m.id === id)
    if (idx === -1) {
      const err = new Error(`Model '${id}' not found`) as any
      err.statusCode = 404
      throw err
    }
    this._models.splice(idx, 1)
    this._write()
  }

  private _write() {
    const content = yaml.dump({ models: this._models }, { lineWidth: 120, quotingType: '"' })
    writeFileSync(this._path, content, 'utf-8')
  }
}

export const modelsStore = new ModelsStore()
