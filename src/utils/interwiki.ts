/**
 * 跨语言 / 跨维基（interwiki / interlanguage）前缀表。
 *
 * 这是**唯一**维护这些前缀的地方：`llm-wiki-tools.ts` 只调用本文件暴露的解析函数，
 * 不要在别处再写一份前缀判断。
 *
 * 数据来源：维基媒体站点的 interwiki 映射表（Wikipedia interlanguage prefixes +
 * 常用跨维基前缀）。键一律小写；值为可替换 `$1` 的页面 URL 模板。
 *
 * 出于安全与体积考虑，这里只保留「读取」所需的信息（前缀 → 目标站点 URL），
 * 不包含任何写入 / 登录信息；跨维基查询由上层工具用匿名只读客户端完成。
 */

/** 目标子域与语言代码前缀相同（`xx.wikipedia.org`）的维基百科语言版本。 */
const WIKIPEDIA_IDENTITY_PREFIXES = `
aa ab ace ady af ak als alt am ami an ang ann anp ar arc ary arz as ast atj av avk
awa ay az azb ba ban bar bat-smg bbc bcl bdr be be-tarask bew bg bh bi bjn blk bm
bn bo bol bpy br bs btm bug bxr ca cbk-zam cdo ce ceb ch cho chr chy ckb co cr crh
cs csb cu cv cy da dag de dga din diq dsb dtp dty dv dz ee el eml en eo es et eu ext
fa fat ff fi fiu-vro fj fo fon fr frp frr fur fy ga gag gan gcr gd gl glk gn gom
gor got gpe gu guc gur guw gv ha hak haw he hi hif ho hr hsb ht hu hy hyw hz ia iba
id ie ig igl ii ik ilo inh io is isv it iu ja jam jbo jv ka kaa kab kai kaj kbd kbp
kcg kg kge ki kj kk kl km kn knc ko koi kr krc ks ksh ku kus kv kw ky la lad lb lbe
lez lfn lg li lij lld lmo ln lo lrc lt ltg lv mad mag mai map-bms mdf mg mh mhr mi
min mk ml mn mni mnw mo mos mr mrj ms mt mus mwl my myv mzn na nah nap nds nds-nl ne
new ng nia nl nn no nov nqo nr nrm nso nup nv ny oc olo om or os pa pag pam pap pcd
pcm pdc pfl pi pih pl pms pnb pnt ppl ps pt pwn qu rki rm rmy rn ro roa-rup roa-tara
rsk ru rue rw sa sah sat sc scn sco sd se sg sh shi shn shy si simple sk skr sl sm
smn sn so sq sr srn ss st stq su sv sw syl szl szy ta tay tcy tdd te tet tg th ti tig
tk tl tly tn to tok tpi tr trv ts tt tum tw ty tyv udm ug uk ur uz ve vec vep vi vls
vo wa war wo wuu xal xh xmf yi yo za zea zgh zh zh-classical zh-min-nan zh-yue zu
`
  .trim()
  .split(/\s+/);

/** 语言代码前缀与目标子域不一致的别名（如 gsw → als、nb → no、zh-cn → zh）。 */
const WIKIPEDIA_ALIASES: Record<string, string> = {
  "be-x-old": "be-tarask",
  gsw: "als",
  lzh: "zh-classical",
  nan: "zh-min-nan",
  rup: "roa-rup",
  sgs: "bat-smg",
  vro: "fiu-vro",
  egl: "eml",
  "en-simple": "simple",
  nb: "no",
  "zh-cn": "zh",
  "zh-tw": "zh",
  yue: "zh-yue",
};

/** 非维基百科的跨维基项目（共享资源、元维基、维基数据等）。 */
const PROJECT_PREFIXES: Record<string, string> = {
  c: "https://commons.wikimedia.org/wiki/$1",
  commons: "https://commons.wikimedia.org/wiki/$1",
  m: "https://meta.wikimedia.org/wiki/$1",
  meta: "https://meta.wikimedia.org/wiki/$1",
  metawiki: "https://meta.wikimedia.org/wiki/$1",
  metawikimedia: "https://meta.wikimedia.org/wiki/$1",
  metawikipedia: "https://meta.wikimedia.org/wiki/$1",
  d: "https://www.wikidata.org/wiki/$1",
  wikidata: "https://www.wikidata.org/wiki/$1",
  f: "https://www.wikifunctions.org/wiki/$1",
  wikifunctions: "https://www.wikifunctions.org/wiki/$1",
  mw: "https://www.mediawiki.org/wiki/$1",
  mediawikiwiki: "https://www.mediawiki.org/wiki/$1",
  wikibooks: "https://en.wikibooks.org/wiki/$1",
  jp: "https://ja.wikipedia.org/wiki/$1",
  cmn: "https://zh.wikipedia.org/wiki/$1",
  wikt: "https://zh.wiktionary.org/wiki/$1",
  q: "https://zh.wikiquote.org/wiki/$1",
  b: "https://zh.wikibooks.org/wiki/$1",
  n: "https://zh.wikinews.org/wiki/$1",
  s: "https://zh.wikisource.org/wiki/$1",
  v: "https://zh.wikiversity.org/wiki/$1",
  voy: "https://zh.wikivoyage.org/wiki/$1",
};

function wikipediaUrl(subdomain: string): string {
  return `https://${subdomain}.wikipedia.org/wiki/$1`;
}

/** 前缀（小写）→ 页面 URL 模板（含 `$1`）。 */
export const INTERWIKI_MAP: Record<string, string> = {};
for (const prefix of WIKIPEDIA_IDENTITY_PREFIXES) {
  INTERWIKI_MAP[prefix] = wikipediaUrl(prefix);
}
for (const [prefix, subdomain] of Object.entries(WIKIPEDIA_ALIASES)) {
  INTERWIKI_MAP[prefix] = wikipediaUrl(subdomain);
}
Object.assign(INTERWIKI_MAP, PROJECT_PREFIXES);

/** 由页面 URL 模板推导该站点的 `api.php` 地址（`…/wiki/$1` → `…/w/api.php`）。 */
export function urlToApiUrl(url: string): string {
  const base = url.replace(/\/wiki\/\$1$/, "");
  return `${base}/w/api.php`;
}

/** 查询某个前缀对应的页面 URL 模板；不是已知前缀时返回 undefined。 */
export function interwikiUrlForPrefix(prefix: string): string | undefined {
  return INTERWIKI_MAP[prefix.trim().replace(/^:/, "").toLowerCase()];
}

/** 查询某个前缀对应的目标维基 `api.php` 地址；不是已知前缀时返回 undefined。 */
export function interwikiApiUrlForPrefix(prefix: string): string | undefined {
  const url = interwikiUrlForPrefix(prefix);
  return url ? urlToApiUrl(url) : undefined;
}

export type ResolvedInterwiki = {
  /** 命中的前缀（已小写），如 `en`、`c`、`d`。 */
  prefix: string;
  /** 去掉前缀后的目标页面标题。 */
  title: string;
  /** 目标页面 URL 模板。 */
  url: string;
  /** 目标维基 `api.php` 地址。 */
  apiUrl: string;
};

/**
 * 解析形如 `en:Artificial intelligence`、`c:File:Example.svg`、`d:Q42` 的跨维基目标。
 *
 * 只有「第一个冒号之前的前缀」命中 {@link INTERWIKI_MAP} 时才认为是跨维基链接，
 * 因此 `Category:…`、`File:…`、`User talk:…`、`Wikipedia:…` 等本地命名空间不受影响。
 * 不是跨维基链接（或前缀后标题为空）时返回 undefined。
 */
export function resolveInterwiki(value: string): ResolvedInterwiki | undefined {
  const colon = value.indexOf(":");
  if (colon <= 0) return undefined;
  const prefix = value.slice(0, colon).trim().toLowerCase();
  const url = INTERWIKI_MAP[prefix];
  if (!url) return undefined;
  const title = value.slice(colon + 1).trim();
  if (!title) return undefined;
  return { prefix, title, url, apiUrl: urlToApiUrl(url) };
}
