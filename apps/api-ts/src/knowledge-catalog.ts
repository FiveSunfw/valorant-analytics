export const KNOWLEDGE_SOURCES = [
  {
    id: "bili-haven-defense",
    url: "https://www.bilibili.com/video/BV1tM4y1j7mE/",
    title: "无畏契约全地图教学——隐士修所（上），防守思路与选位",
    author: "大东彦",
    published: "2023-07-09"
  },
  {
    id: "bili-haven-attack",
    url: "https://www.bilibili.com/video/BV1p94y1e7f4/",
    title: "5分钟教你玩转隐世修所的进攻，进攻战术解析与爆弹执行",
    author: "大东彦",
    published: "2023-08-01"
  },
  {
    id: "bili-ascent-defense",
    url: "https://www.bilibili.com/video/BV1gW4y1L7uw/",
    title: "无畏契约全地图教学——亚海悬城（上），基础攻守全解",
    author: "大东彦",
    published: "2023-06-01"
  },
  {
    id: "bili-ascent-attack",
    url: "https://www.bilibili.com/video/BV1RY411z7dV/",
    title: "无畏契约全地图教学——亚海悬城（中），进阶进攻思路与战术执行",
    author: "大东彦",
    published: "2023-06-01"
  }
] as const;

export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];
