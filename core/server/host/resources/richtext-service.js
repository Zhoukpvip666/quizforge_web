import fs from 'node:fs';
import path from 'node:path';
import { ApiError, bad, id } from '../platform/errors.js';
import { exists, readJson, safeDirectory } from '../platform/files.js';
import { cloneJson, fingerprint, integralField } from '../platform/json.js';

const PROFILES = new Set(['basic-v1', 'advanced-v1']);
const CAPABILITIES = new Set(['basic-formatting', 'images', 'advanced-formatting', 'tables', 'math', 'image-resize', 'camera-capture']);
const properties = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const integer = (value, minimum) => Number.isInteger(value) && value >= minimum && value <= 2147483647;
const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
const invalidRegistry = () => new ApiError(422, 'INVALID_RICHTEXT_SERVICE', '应用的富文本公共服务配置无效，请修复或重新安装应用；题库和拓展原文件未修改。');
function capabilities(value, code) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new ApiError(422, code, '富文本 capabilities 必须是能力名称数组。');
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 100 || seen.has(item)) throw new ApiError(422, code, '富文本 capabilities 必须包含不重复的非空字符串。');
    seen.add(item);
  }
  return [...value];
}
export function validateSdk(id, value) { if (id !== 'quizforge.richtext' || !version(value)) throw new ApiError(404, 'SDK_UNAVAILABLE', 'Unsupported public SDK package or version'); }
export class RichTextService {
  constructor(codeRoot) { this.directory = path.join(codeRoot, 'shared', 'richtext'); this.cachedStamp = null; this.cachedRegistry = null; }
  registry(required) {
    const file = path.join(this.directory, 'service.json');
    try { safeDirectory(this.directory); }
    catch { throw invalidRegistry(); }
    if (!exists(file)) {
      this.cachedStamp = null; this.cachedRegistry = null;
      if (required) throw new ApiError(422, 'RICHTEXT_SERVICE_UNAVAILABLE', '应用未安装富文本公共服务，无法满足拓展的 requiresRichText 声明。');
      return null;
    }
    let value, stamp;
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw invalidRegistry();
      stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
      if (stamp === this.cachedStamp) return this.cachedRegistry;
      value = readJson(file, 64 * 1024);
    } catch { throw invalidRegistry(); }
    if (!properties(value, ['schemaVersion', 'api', 'defaultProfile', 'profiles']) || !integralField(value, 'schemaVersion') || value.schemaVersion !== 1 || !properties(value.api, ['major', 'minor', 'documentFormat']) || !['major', 'minor', 'documentFormat'].every(key => integralField(value.api, key)) || value.api.major !== 1 || !integer(value.api.minor, 0) || value.api.minor > 1 || value.api.documentFormat !== 1 || !Array.isArray(value.profiles) || value.profiles.length < 1 || value.profiles.length > 2 || typeof value.defaultProfile !== 'string') throw invalidRegistry();
    const ids = new Set(), versions = new Set();
    for (const profile of value.profiles) {
      if (!properties(profile, ['id', 'provider', 'capabilities', 'legacyVersions']) || !PROFILES.has(profile.id) || ids.has(profile.id) || !properties(profile.provider, ['id', 'version']) || profile.provider.id !== 'quizforge.richtext' || !version(profile.provider.version)) throw invalidRegistry();
      ids.add(profile.id);
      const supported = capabilities(profile.capabilities, 'INVALID_RICHTEXT_SERVICE');
      if (!supported.length || supported.some(capability => !CAPABILITIES.has(capability)) || (profile.id === 'basic-v1' && supported.some(capability => !['basic-formatting', 'images'].includes(capability)))) throw invalidRegistry();
      if (!Array.isArray(profile.legacyVersions) || profile.legacyVersions.length > 100) throw invalidRegistry();
      for (const alias of profile.legacyVersions) { if (!version(alias) || versions.has(alias)) throw invalidRegistry(); versions.add(alias); }
    }
    if (!ids.has(value.defaultProfile)) throw invalidRegistry();
    this.cachedStamp = stamp; this.cachedRegistry = value; return value;
  }
  resolution(registry, profile) {
    const contentApi = { ...registry.api, documentProfile: profile.id, capabilities: [...profile.capabilities] }, provider = cloneJson(profile.provider);
    return { dependencies: [provider], contentApi, revision: fingerprint({ ...provider, api: contentApi }, 'quizforge-richtext-service-v1') };
  }
  resolve(manifest) {
    const hasRequirement = Object.hasOwn(manifest, 'requiresRichText'), hasDependencies = Object.hasOwn(manifest, 'dependencies');
    if (hasRequirement && hasDependencies) throw new ApiError(422, 'INVALID_RICHTEXT_REQUIREMENT', 'requiresRichText 与旧 dependencies 不能同时声明，请只声明富文本公共接口需求。');
    if (hasRequirement) {
      const requirement = manifest.requiresRichText, registry = this.registry(true);
      if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement) || Object.keys(requirement).some(key => !['major', 'minMinor', 'documentFormat', 'documentProfile', 'capabilities'].includes(key)) || !['major', 'minMinor', 'documentFormat'].every(key => integralField(requirement, key)) || !integer(requirement.major, 1) || !integer(requirement.minMinor, 0) || !integer(requirement.documentFormat, 1) || typeof requirement.documentProfile !== 'string') throw new ApiError(422, 'INVALID_RICHTEXT_REQUIREMENT', 'requiresRichText 必须声明整数 major、minMinor、documentFormat 以及 documentProfile，可选 capabilities。');
      if (requirement.major !== registry.api.major || requirement.minMinor > registry.api.minor) throw new ApiError(422, 'UNSUPPORTED_RICHTEXT_API', '拓展需要的富文本接口版本尚未得到应用支持，请使用兼容拓展或升级应用；原题库未修改。');
      if (requirement.documentFormat !== registry.api.documentFormat) throw new ApiError(422, 'UNSUPPORTED_RICHTEXT_DOCUMENT_FORMAT', '拓展需要的富文本文档格式尚未得到应用支持；原题库未修改。');
      const profile = registry.profiles.find(profile => profile.id === requirement.documentProfile);
      if (!profile) throw new ApiError(422, 'UNSUPPORTED_RICHTEXT_PROFILE', `应用不支持富文本文档配置「${requirement.documentProfile}」。请使用兼容拓展或向开发者反馈。`);
      for (const capability of capabilities(requirement.capabilities, 'INVALID_RICHTEXT_REQUIREMENT')) if (!profile.capabilities.includes(capability)) throw new ApiError(422, 'UNSUPPORTED_RICHTEXT_CAPABILITY', `富文本文档配置「${profile.id}」不支持能力「${capability}」。请使用兼容拓展或向开发者反馈。`);
      return this.resolution(registry, profile);
    }
    if (!hasDependencies) return { dependencies: [], contentApi: null, revision: '' };
    if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length > 4) throw bad('Invalid SDK dependencies');
    const dependencies = [], seen = new Set(); let contentApi = null, revision = '', registry;
    for (const dependency of manifest.dependencies) {
      if (!properties(dependency, ['id', 'version'])) throw bad('Invalid SDK dependency');
      const name = id(dependency, 'id'), value = id(dependency, 'version'); validateSdk(name, value);
      if (seen.has(name)) throw bad('Duplicate SDK dependency'); seen.add(name);
      registry ??= this.registry(false);
      const profile = registry?.profiles.find(profile => profile.legacyVersions.includes(value));
      if (!profile) dependencies.push({ id: name, version: value });
      else { const selected = this.resolution(registry, profile); dependencies.push(...selected.dependencies); contentApi = selected.contentApi; revision = selected.revision; }
    }
    return { dependencies, contentApi, revision };
  }
}
