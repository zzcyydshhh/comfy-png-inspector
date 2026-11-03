/**
 * DeepSeek Harness bundle: one model-facing tool, `comfy_png_inspect`.
 *
 * Reads a ComfyUI-generated PNG and reports how the image was produced — the
 * LoRA execution chain with every strength, sampler settings, base model /
 * CLIP / VAE, latent size, prompts, and the canvas nodes that were bypassed.
 *
 * Parsing lives in ../comfy-png-core.js, the same module the browser UI uses.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import '../comfy-png-core.js'

const ComfyPNG = globalThis.ComfyPNG
const MAX_FILES = 200

/** Trim a prompt so a directory sweep does not flood the transcript. */
function clip(text, limit) {
  if (typeof text !== 'string') return ''
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

/** One PNG record → the shape the model reads. */
function summarise(record, includePrompt) {
  const out = {
    file: record.name,
    width: record.width,
    height: record.height,
    bytes: record.size,
    modified: record.mtime ? new Date(record.mtime).toISOString() : null
  }
  if (record.error) {
    out.error = record.error
    return out
  }
  out.seed = record.seed ?? null
  out.steps = record.steps ?? null
  out.cfg = record.cfg ?? null
  out.sampler = record.sampler ?? null
  out.scheduler = record.scheduler ?? null
  out.denoise = record.denoise ?? null
  out.latent = record.latent ?? null
  out.base_model = record.baseModel ?? null
  out.clip = record.clipName
    ? { name: record.clipName, type: record.clipType ?? null }
    : null
  out.vae = record.vaeName ?? null
  out.save_prefix = record.prefix ?? null
  out.pre_sampler = (record.patches || []).map((patch) => ({
    node: `${patch.class_type}#${patch.id}`,
    params: patch.params || {}
  }))
  out.loras = (record.loras || []).map((lora, index) => ({
    order: index + 1,
    node: String(lora.id),
    name: lora.name,
    strength: Number(lora.strength)
  }))
  const workflow = record.workflow || {}
  out.bypassed = (workflow.bypassed || []).map((node) => ({ id: node.id, type: node.type }))
  out.bypassed_count = out.bypassed.length
  if (includePrompt) {
    out.prompt = record.positive || ''
    out.prompt_source = record.positiveSrc || ''
    out.negative = record.negativeGenerated ? '' : (record.negative || '')
    out.negative_generated_at_runtime = Boolean(record.negativeGenerated)
  }
  return out
}

/** Resolve the tool argument into a list of PNG paths. */
async function collect(target, limit) {
  const info = await stat(target)
  if (info.isFile()) {
    return { files: [target], isDirectory: false }
  }
  const names = await readdir(target, { withFileTypes: true })
  const files = names
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
    .map((entry) => path.join(target, entry.name))
    .sort()
    .slice(0, Math.min(limit, MAX_FILES))
  return { files, isDirectory: true }
}

async function inspect(target, options) {
  const limit = Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : 50
  const includePrompt = options.include_prompt !== false
  const { files, isDirectory } = await collect(target, limit)
  const images = []
  for (const file of files) {
    const info = await stat(file)
    const bytes = await readFile(file)
    const record = await ComfyPNG.parsePng(new Uint8Array(bytes), {
      name: path.basename(file),
      path: file,
      size: info.size,
      mtime: info.mtimeMs
    })
    images.push(summarise(record, includePrompt))
  }
  return {
    path: target,
    directory: isDirectory,
    count: images.length,
    images
  }
}

/** Cordis plugin name. */
export const name = 'comfy-png-inspector'

/** Waits for the tool registry before registering. */
export const inject = ['tools']

/**
 * Register the inspection tool.
 * @param ctx - composition scope context.
 */
export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'comfy_png_inspect',
      description:
        'Read a ComfyUI-generated PNG and report how it was made: the LoRA chain with every strength value, sampler / scheduler / steps / cfg / seed, base model, CLIP, VAE, latent size, positive and negative prompts, and any canvas nodes that were bypassed. Accepts one .png file or a directory of .png files.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path to a .png file, or to a directory containing .png files'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of files to read when path is a directory (default 50, cap 200)'
        },
        include_prompt: {
          type: 'boolean',
          description: 'Include the prompt text in the result (default true; set false for a parameter-only sweep)'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            path: { type: 'string' },
            directory: { type: 'boolean' },
            count: { type: 'number' },
            images: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            }
          }
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
      async execute(args) {
        const result = await inspect(args.path, args)
        void clip
        return result
      }
    })
  )
}
