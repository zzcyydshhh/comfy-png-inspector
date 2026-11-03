/* comfy-png-core.js — ComfyUI PNG 元数据解析核心（浏览器 + Node 通用）
 *
 * ComfyUI 把两份 JSON 写进 PNG 的 tEXt / zTXt / iTXt 块：
 *   prompt   —— 提交给服务端的 API 图：{ "12": { class_type, inputs } }
 *   workflow —— 画布图：{ nodes:[{id,type,widgets_values,mode}], links:[...] }
 *
 * 本文件负责：解码 PNG 块 → 从 KSampler.model 回溯出 LoRA 执行链 → 解析采样参数、
 * 底模/CLIP/VAE、正反向提示词（含连线与多输出槽位）→ 读出被 bypass 的节点。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ComfyPNG = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var decoder = new TextDecoder('utf-8', { fatal: false });
  function td(u8) { return decoder.decode(u8); }

  function isRef(v) {
    return Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number');
  }

  async function inflate(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持 DecompressionStream（需要 Chrome/Edge 103+）');
    var ds = new DecompressionStream('deflate'); // PNG 的 zlib 流
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** 读取 PNG 文本块，返回 { meta, width, height } */
  async function readPngInfo(bytes) {
    if (!(bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)) {
      throw new Error('不是 PNG 文件');
    }
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = 8, meta = {}, width = 0, height = 0, waits = [];
    var findZero = function (u8, from) {
      for (var i = from; i < u8.length; i++) if (u8[i] === 0) return i;
      return -1;
    };
    while (pos + 8 <= bytes.byteLength) {
      var len = view.getUint32(pos);
      var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      var bodyStart = pos + 8;
      var body = bytes.subarray(bodyStart, bodyStart + len);
      pos = bodyStart + len + 4; // 跳过 CRC
      if (type === 'IHDR') {
        width = view.getUint32(bodyStart);
        height = view.getUint32(bodyStart + 4);
      } else if (type === 'tEXt') {
        var z1 = findZero(body, 0);
        meta[td(body.subarray(0, z1))] = td(body.subarray(z1 + 1));
      } else if (type === 'zTXt') {
        var z2 = findZero(body, 0);
        const kz = td(body.subarray(0, z2));
        waits.push(inflate(body.subarray(z2 + 2)).then(function (out) { meta[kz] = td(out); }).catch(function () {}));
      } else if (type === 'iTXt') {
        var z3 = findZero(body, 0);
        const ki = td(body.subarray(0, z3));
        var compFlag = body[z3 + 1];
        var rest = body.subarray(z3 + 3);
        var z4 = findZero(rest, 0);          // 语言标签
        var rest2 = rest.subarray(z4 + 1);
        var z5 = findZero(rest2, 0);         // 翻译关键词
        var textBytes = rest2.subarray(z5 + 1);
        if (compFlag === 1) {
          waits.push(inflate(textBytes).then(function (out) { meta[ki] = td(out); }).catch(function () {}));
        } else {
          meta[ki] = td(textBytes);
        }
      } else if (type === 'IEND') {
        break;
      }
    }
    await Promise.all(waits);
    return { meta: meta, width: width, height: height };
  }

  /** 把 CLIPTextEncode.text 解析成字符串，返回 { text, src, generated } */
  function resolveText(prompt, val, depth) {
    depth = depth || 0;
    if (typeof val === 'string') return { text: val, src: 'literal', generated: false };
    if (depth > 12 || !isRef(val)) return { text: '', src: '?', generated: false };
    var nid = String(val[0]), slot = val[1];
    var node = prompt[nid];
    if (!node) return { text: '', src: '<节点 ' + nid + ' 不存在>', generated: false };
    var ctype = node.class_type || '?';
    var ins = node.inputs || {};
    var generated = slot !== 0 && slot !== null && slot !== undefined;
    var keys = ['text', 'string', 'value', 'prompt', 'positive', 'text_g'];
    for (var i = 0; i < keys.length; i++) {
      var v = ins[keys[i]];
      if (typeof v === 'string') {
        return {
          text: generated ? '' : v,
          src: ctype + '#' + nid + '.' + keys[i] + '[slot ' + slot + ']',
          generated: generated
        };
      }
    }
    for (var k in ins) {
      if (isRef(ins[k])) {
        var sub = resolveText(prompt, ins[k], depth + 1);
        if (sub.text || sub.generated) {
          return {
            text: sub.text,
            src: ctype + '#' + nid + '.' + k + '[slot ' + slot + '] ← ' + sub.src,
            generated: sub.generated || generated
          };
        }
      }
    }
    return { text: '', src: ctype + '#' + nid + '[slot ' + slot + ']', generated: generated };
  }

  /** 从 KSampler.model 往回爬，返回按执行顺序排列的节点数组 */
  function traceModelChain(prompt, start) {
    var chain = [], seen = {}, ref = start;
    while (isRef(ref)) {
      var nid = String(ref[0]);
      if (seen[nid]) break;
      seen[nid] = 1;
      var node = prompt[nid];
      if (!node) break;
      var ctype = node.class_type || '?';
      var ins = node.inputs || {};
      var entry = { id: nid, class_type: ctype };
      if (ctype.indexOf('LoraLoader') === 0) {
        entry.kind = 'lora';
        entry.name = ins.lora_name || ins.lora_name_high || ins.lora_name_low || '?';
        entry.strength = ins.strength_model !== undefined ? ins.strength_model : ins.strength;
        if (ins.strength_clip !== undefined) entry.strength_clip = ins.strength_clip;
      } else if (['ModelSamplingAuraFlow', 'ModelSamplingFlux', 'CFGNorm', 'ModelSamplingSD3',
                  'ModelSamplingDiscrete', 'FreeU', 'FreeU_V2', 'RescaleCFG'].indexOf(ctype) >= 0) {
        entry.kind = 'patch';
        entry.params = {};
        for (var k in ins) if (!isRef(ins[k])) entry.params[k] = ins[k];
      } else {
        entry.kind = ctype.indexOf('Loader') >= 0 ? 'loader' : 'other';
        entry.params = {};
        for (var k2 in ins) if (!isRef(ins[k2])) entry.params[k2] = ins[k2];
      }
      chain.push(entry);
      ref = ins.model;
    }
    return chain.reverse();
  }

  function findFirst(prompt, types) {
    for (var nid in prompt) if (types.indexOf(prompt[nid].class_type) >= 0) return nid;
    return null;
  }

  /** 分析 API 图 */
  function analyzePrompt(prompt) {
    var rec = { loras: [], patches: [], chain: [] };
    var sid = findFirst(prompt, ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']);
    var scls = sid ? prompt[sid].class_type : null;
    rec.samplerNode = sid ? scls + '#' + sid : null;

    if (scls && scls.indexOf('KSampler') === 0) {
      var sp = prompt[sid].inputs || {};
      rec.seed = sp.noise_seed !== undefined ? sp.noise_seed : sp.seed;
      rec.steps = sp.steps;
      rec.cfg = sp.cfg;
      rec.sampler = sp.sampler_name;
      rec.scheduler = sp.scheduler;
      rec.denoise = sp.denoise;
    }

    var modelRef = (sid && prompt[sid].inputs) ? prompt[sid].inputs.model : null;
    if (!modelRef) {
      var uid = findFirst(prompt, ['UNETLoader', 'CheckpointLoaderSimple']);
      modelRef = uid ? [uid, 0] : null;
    }
    rec.chain = modelRef ? traceModelChain(prompt, modelRef) : [];
    rec.loras = rec.chain.filter(function (c) { return c.kind === 'lora'; });
    rec.patches = rec.chain.filter(function (c) { return c.kind === 'patch'; });

    for (var nid in prompt) {
      var ins = prompt[nid].inputs || {}, ct = prompt[nid].class_type || '';
      if (ins.unet_name && !rec.baseModel) rec.baseModel = ins.unet_name;
      if (ins.ckpt_name && !rec.baseModel) rec.baseModel = ins.ckpt_name;
      if (ins.clip_name && !rec.clip) {
        rec.clip = ins.clip_name + (ins.type ? ' (' + ins.type + ')' : '') + ' [' + ct + '#' + nid + ']';
        rec.clipName = ins.clip_name;
        rec.clipType = ins.type;
      }
      if (ins.vae_name && !rec.vae) {
        rec.vae = ins.vae_name + ' [' + ct + '#' + nid + ']';
        rec.vaeName = ins.vae_name;
      }
      if (ins.filename_prefix && !rec.prefix) rec.prefix = ins.filename_prefix;
      if (ct.indexOf('Empty') === 0 && ct.indexOf('Latent') >= 0 && ins.width !== undefined && !rec.latent) {
        rec.latent = ins.width + '×' + ins.height + ' ×' + (ins.batch_size === undefined ? 1 : ins.batch_size) + ' [' + ct + '#' + nid + ']';
        rec.width = ins.width;
        rec.height = ins.height;
      }
    }

    rec.positive = rec.negative = '';
    rec.positiveSrc = rec.negativeSrc = '';
    if (sid) {
      var si = prompt[sid].inputs || {};
      var posRef = si.positive, negRef = si.negative;
      if ((!posRef || !negRef) && isRef(si.guider)) {
        var g = (prompt[String(si.guider[0])] || {}).inputs || {};
        posRef = posRef || g.positive;
        negRef = negRef || g.negative;
      }
      if (posRef) {
        var p = resolveText(prompt, posRef);
        rec.positive = p.text; rec.positiveSrc = p.src; rec.positiveGenerated = p.generated;
      }
      if (negRef) {
        var n = resolveText(prompt, negRef);
        rec.negative = n.text; rec.negativeSrc = n.src; rec.negativeGenerated = n.generated;
      }
    }
    rec.nodeCount = Object.keys(prompt).length;
    return rec;
  }

  /** 分析画布图：bypass(mode 4) / mute(mode 2) */
  function analyzeWorkflow(wf) {
    var out = { bypassed: [], muted: [], notes: [], nodeCount: (wf.nodes || []).length };
    (wf.nodes || []).forEach(function (n) {
      var w = n.widgets_values;
      var label = Array.isArray(w) && w.length ? w[0] : null;
      var item = { id: n.id, type: n.type, label: label };
      if (n.mode === 4) out.bypassed.push(item);
      else if (n.mode === 2) out.muted.push(item);
      if (n.type === 'Note' && Array.isArray(w) && w.length) out.notes.push({ id: n.id, text: String(w[0]).slice(0, 2000) });
    });
    return out;
  }

  /** 一条记录：PNG 字节 → 全部参数 */
  async function parsePng(bytes, fileInfo) {
    fileInfo = fileInfo || {};
    var info = await readPngInfo(bytes);
    var rec = {
      name: fileInfo.name || 'image.png',
      path: fileInfo.path || '',
      size: fileInfo.size || bytes.byteLength,
      mtime: fileInfo.mtime || null,
      width: info.width,
      height: info.height,
      pngSize: info.width + '×' + info.height,
      // 即使没有元数据，字段也保持可渲染
      loras: [], patches: [], chain: [],
      positive: '', negative: '', positiveSrc: '', negativeSrc: '',
      positiveGenerated: false, negativeGenerated: false,
      workflow: { bypassed: [], muted: [], notes: [], nodeCount: 0 }
    };
    var prompt = null, workflow = null;
    try { if (info.meta.prompt) prompt = JSON.parse(info.meta.prompt); } catch (e) { rec.warn = 'prompt 块 JSON 解析失败'; }
    try { if (info.meta.workflow) workflow = JSON.parse(info.meta.workflow); } catch (e) {}
    if (prompt) Object.assign(rec, analyzePrompt(prompt));
    if (workflow) rec.workflow = analyzeWorkflow(workflow);
    if (!prompt && !workflow) {
      if (info.meta.parameters) rec.a1111 = info.meta.parameters;
      else rec.error = '没有 ComfyUI 元数据（可能被软件重新保存过，元数据会丢）';
    }
    rec.metaKeys = Object.keys(info.meta);
    rec._prompt = prompt;
    rec._workflow = workflow;
    return rec;
  }

  /* ============================ 工作流重组 ============================
   * 用「模板画布工作流」+「从 PNG 解析出的参数」拼出一份可导入 ComfyUI 的新工作流。
   * 原则：模板做深拷贝，绝不写回、绝不改动模板文件。
   * ================================================================== */

  function fmtVal(v) {
    if (v === undefined) return '（空）';
    if (typeof v === 'string') return v.length > 60 ? JSON.stringify(v.slice(0, 60) + '…') : JSON.stringify(v);
    return String(v);
  }

  function deepest(o) { return JSON.parse(JSON.stringify(o)); }

  function resyncNodeRefs(wf) {
    var live = {};
    (wf.links || []).forEach(function (l) { live[l[0]] = l; });
    (wf.nodes || []).forEach(function (n) {
      (n.inputs || []).forEach(function (i) { if (i.link !== null && i.link !== undefined && !live[i.link]) i.link = null; });
      (n.outputs || []).forEach(function (o) {
        o.links = (o.links || []).filter(function (id) { return !!live[id]; });
      });
    });
  }

  /**
   * @param {object} template 画布工作流 JSON（nodes/links/widgets_values）
   * @param {object} rec      parsePng 的结果
   * @returns {{workflow:object, report:string[], warnings:string[]}}
   */
  function composeWorkflow(template, rec) {
    if (!template || !Array.isArray(template.nodes)) throw new Error('模板不是画布工作流 JSON（缺少 nodes 数组）');
    var wf = deepest(template);
    var report = [], warnings = [];
    wf.nodes.forEach(function (n) { if (!n.inputs) n.inputs = []; if (!n.outputs) n.outputs = []; });
    if (!Array.isArray(wf.links)) wf.links = [];

    var maxNode = 0, maxLink = 0;
    wf.nodes.forEach(function (n) { if (n.id > maxNode) maxNode = n.id; });
    wf.links.forEach(function (l) { if (l[0] > maxLink) maxLink = l[0]; });
    var nextNode = Math.max(maxNode, wf.last_node_id || 0);
    var nextLink = Math.max(maxLink, wf.last_link_id || 0);

    var nodeById = function (id) {
      for (var i = 0; i < wf.nodes.length; i++) if (wf.nodes[i].id === id) return wf.nodes[i];
      return null;
    };
    var inputIndex = function (node, name) {
      for (var i = 0; i < (node.inputs || []).length; i++) if (node.inputs[i].name === name) return i;
      return -1;
    };
    function setW(node, idx, val, label) {
      if (!node || val === undefined || val === null || val === '') return;
      if (!Array.isArray(node.widgets_values)) node.widgets_values = [];
      var old = node.widgets_values[idx];
      if (old === val) return;
      node.widgets_values[idx] = val;
      report.push(label + ' #' + node.id + '  ' + fmtVal(old) + ' → ' + fmtVal(val));
    }
    function addLink(origin, originSlot, target, targetSlot, type) {
      var id = ++nextLink;
      wf.links.push([id, origin, originSlot, target, targetSlot, type]);
      var on = nodeById(origin), tn = nodeById(target);
      if (on && on.outputs && on.outputs[originSlot]) {
        if (!on.outputs[originSlot].links) on.outputs[originSlot].links = [];
        on.outputs[originSlot].links.push(id);
      }
      if (tn && tn.inputs && tn.inputs[targetSlot]) tn.inputs[targetSlot].link = id;
      return id;
    }

    /* ---- 1. 文本 ---- */
    var enh = wf.nodes.filter(function (n) { return n.type === 'ZhPromptEnhance'; })[0];
    if (enh && rec.positive) setW(enh, 0, rec.positive, '提示词');
    else {
      var ks0 = wf.nodes.filter(function (n) { return n.type === 'KSampler' || n.type === 'KSamplerAdvanced'; })[0];
      if (ks0) {
        var linkMap = {};
        wf.links.forEach(function (l) { linkMap[l[0]] = l; });
        ['positive', 'negative'].forEach(function (key) {
          var ii = inputIndex(ks0, key);
          if (ii < 0 || ks0.inputs[ii].link === null) return;
          var lk = linkMap[ks0.inputs[ii].link];
          if (!lk) return;
          var src = nodeById(lk[1]);
          if (!src || src.type !== 'CLIPTextEncode') return;
          if ((src.inputs || []).some(function (x) { return x.name === 'text' && x.link !== null; })) return; // 文本来自连线，别覆盖
          var txt = key === 'positive' ? rec.positive : (rec.negativeGenerated ? '' : rec.negative);
          if (txt) setW(src, 0, txt, key === 'positive' ? '正向提示词' : '反向提示词');
        });
      }
    }

    /* ---- 2. 底模 / CLIP / VAE / latent / 采样 / 前缀 ---- */
    wf.nodes.forEach(function (n) {
      if (n.type === 'UNETLoader' && rec.baseModel) setW(n, 0, rec.baseModel, '底模');
      else if (n.type === 'CheckpointLoaderSimple' && rec.baseModel) setW(n, 0, rec.baseModel, '底模');
      else if ((n.type === 'CLIPLoaderGGUF' || n.type === 'CLIPLoader') && rec.clipName) {
        setW(n, 0, rec.clipName, 'CLIP');
        if (rec.clipType) setW(n, 1, rec.clipType, 'CLIP type');
      } else if (n.type === 'VAELoader' && rec.vaeName) setW(n, 0, rec.vaeName, 'VAE');
      else if (/^Empty.*Latent/.test(n.type) && rec.width && rec.height) {
        setW(n, 0, rec.width, '宽度');
        setW(n, 1, rec.height, '高度');
      } else if (n.type === 'KSampler' || n.type === 'KSamplerAdvanced') {
        var off = n.type === 'KSamplerAdvanced' ? 1 : 0;   // Advanced 多了 add_noise / start_at_step 等，只动稳妥的项
        if (n.type === 'KSampler') {
          if (rec.seed !== undefined && rec.seed !== null) setW(n, 0, rec.seed, '种子');
          if (rec.steps !== undefined) setW(n, 2, rec.steps, '步数');
          if (rec.cfg !== undefined) setW(n, 3, rec.cfg, 'CFG');
          if (rec.sampler) setW(n, 4, rec.sampler, '采样器');
          if (rec.scheduler) setW(n, 5, rec.scheduler, '调度器');
          if (rec.denoise !== undefined) setW(n, 6, rec.denoise, '降噪');
        }
      } else if (n.type === 'SaveImage' && rec.prefix) setW(n, 0, rec.prefix, '保存前缀');
    });

    /* ---- 3. 重建 LoRA 链 ---- */
    var loras = rec.loras || [];
    var loraNodes = wf.nodes.filter(function (n) { return n.type.indexOf('LoraLoader') === 0; });
    var head = wf.nodes.filter(function (n) {
      return n.type === 'UNETLoader' || n.type === 'CheckpointLoaderSimple';
    })[0];
    if (!head) {
      warnings.push('模板里找不到 UNETLoader / CheckpointLoaderSimple，LoRA 链无法重建');
    } else {
      // 顺着 head 的 MODEL 输出走到第一个非 LoRA 消费者
      var lmap = {};
      wf.links.forEach(function (l) { lmap[l[0]] = l; });
      var cur = head, consumer = null, consumerSlot = -1, guard = 0;
      while (guard++ < 200) {
        var out0 = (cur.outputs || [])[0];
        var lid = out0 && out0.links && out0.links[0];
        if (!lid) break;
        var l0 = lmap[lid];
        if (!l0) break;
        var tgt = nodeById(l0[3]);
        if (!tgt) break;
        if (tgt.type.indexOf('LoraLoader') === 0) { cur = tgt; continue; }
        consumer = tgt; consumerSlot = l0[4]; break;
      }

      var proto = loraNodes[0] || null;
      var basePos = proto && proto.pos ? proto.pos.slice() : [head.pos ? head.pos[0] : 100, (head.pos ? head.pos[1] : 100) + 120];
      var protoProps = proto && proto.properties ? deepest(proto.properties) : { 'Node name for S&R': 'LoraLoaderModelOnly' };

      // 摘掉模板原有的 LoRA 节点及连线
      var dead = {};
      loraNodes.forEach(function (n) { dead[n.id] = 1; });
      if (Object.keys(dead).length) {
        report.push('移除模板原有 LoRA 节点 ' + Object.keys(dead).join(',') + '（只改这份副本）');
      }
      wf.nodes = wf.nodes.filter(function (n) { return !dead[n.id]; });
      wf.links = wf.links.filter(function (l) { return !dead[l[1]] && !dead[l[3]]; });
      resyncNodeRefs(wf);

      var tailId = head.id, tailSlot = 0;
      (head.outputs || []).forEach(function (o) { o.links = []; });

      loras.forEach(function (l, i) {
        var nid = ++nextNode;
        var strength = Number(l.strength);
        if (isNaN(strength)) strength = 1;
        var node = {
          id: nid, type: 'LoraLoaderModelOnly',
          pos: [basePos[0], basePos[1] + i * 100],
          size: [315, 82], flags: {}, order: (proto ? proto.order : 0) + i,
          mode: 0,
          inputs: [
            { name: 'model', type: 'MODEL', link: null },
            { name: 'lora_name', type: 'COMBO', link: null },
            { name: 'strength_model', type: 'FLOAT', link: null }
          ],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [] }],
          properties: deepest(protoProps),
          widgets_values: [l.name, strength]
        };
        wf.nodes.push(node);
        addLink(tailId, tailSlot, nid, 0, 'MODEL');
        tailId = nid; tailSlot = 0;
        report.push('LoRA ' + (i + 1) + '/' + loras.length + ' #' + nid + '  ' + l.name + ' = ' + strength.toFixed(2));
      });

      if (consumer && consumerSlot >= 0) {
        addLink(tailId, tailSlot, consumer.id, consumerSlot, 'MODEL');
        report.push('末端接到 ' + consumer.type + '#' + consumer.id + ' 的 model 输入');
      } else if (loras.length) {
        warnings.push('没找到 LoRA 链的末端消费者，链条末端保持未连接');
      }
      if (!loras.length) report.push('这张图没有 LoRA，模板里的 LoRA 节点已全部摘除');
    }

    wf.last_node_id = nextNode;
    wf.last_link_id = nextLink;
    resyncNodeRefs(wf);

    /* ---- 4. 自检 ---- */
    var ids = {}, id2type = {};
    wf.nodes.forEach(function (n) { ids[n.id] = 1; id2type[n.id] = n.type; });
    wf.links.forEach(function (l) {
      if (!ids[l[1]]) warnings.push('连线 ' + l[0] + ' 的起点节点 ' + l[1] + ' 不存在');
      if (!ids[l[3]]) warnings.push('连线 ' + l[0] + ' 的终点节点 ' + l[3] + ' 不存在');
      if (l[1] === l[3]) warnings.push('自连：连线 ' + l[0]);
    });
    var ks = wf.nodes.filter(function (n) { return n.type === 'KSampler' || n.type === 'KSamplerAdvanced'; })[0];
    if (!ks) warnings.push('副本里没有 KSampler');
    else {
      var mi = inputIndex(ks, 'model');
      if (mi < 0 || ks.inputs[mi].link === null) warnings.push('KSampler 的 model 输入没有接线');
      var pi = inputIndex(ks, 'positive');
      if (pi < 0 || ks.inputs[pi].link === null) warnings.push('KSampler 的 positive 没有接线');
    }
    var loraCount = wf.nodes.filter(function (n) { return n.type.indexOf('LoraLoader') === 0; }).length;
    if (loraCount !== loras.length) warnings.push('LoRA 节点数 ' + loraCount + ' 与解析出的 ' + loras.length + ' 个不一致');

    return { workflow: wf, report: report, warnings: warnings };
  }

  /* ============================ 极简 ZIP（store，无压缩） ============================ */
  var crcTable = null;
  function crc32(u8) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var i = 0; i < 256; i++) {
        var c = i;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[i] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var j = 0; j < u8.length; j++) crc = crcTable[(crc ^ u8[j]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /** entries: [{name, data:Uint8Array}] → Uint8Array(zip) */
  function zipStore(entries) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    function u32(v) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; }
    function u16(v) { var b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xFFFF, true); return b; }
    entries.forEach(function (e) {
      var name = enc.encode(e.name);
      var data = e.data;
      var crc = crc32(data);
      var local = [].concat(
        [u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
         u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)],
        [name]
      );
      var localLen = 30 + name.length;
      parts = parts.concat(local, [data]);
      central = central.concat([].concat(
        [u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
         u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
         u16(0), u16(0), u32(0), u32(offset)],
        [name]
      ));
      offset += localLen + data.length;
    });
    var cdStart = offset, cdSize = 0;
    central.forEach(function (c) { cdSize += c.reduce(function (n, x) { return n + x.length; }, 0); });
    var eocd = [u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(cdSize), u32(cdStart), u16(0)];
    var all = parts.concat(central, eocd);
    var total = all.reduce(function (n, x) { return n + x.length; }, 0);
    var out = new Uint8Array(total), off = 0;
    all.forEach(function (x) { out.set(x, off); off += x.length; });
    return out;
  }

  return {
    readPngInfo: readPngInfo,
    parsePng: parsePng,
    analyzePrompt: analyzePrompt,
    analyzeWorkflow: analyzeWorkflow,
    resolveText: resolveText,
    traceModelChain: traceModelChain,
    composeWorkflow: composeWorkflow,
    zipStore: zipStore,
    crc32: crc32
  };
});
