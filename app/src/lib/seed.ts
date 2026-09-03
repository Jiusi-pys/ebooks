import type { Book, Highlight, Note } from '@/types';
import { getAllBooks, putBook, putHighlight, putNote } from './db';

/** 首次启动写入示例书与互链笔记，让双链/图谱开箱可见 */
export async function seedIfEmpty() {
  const books = await getAllBooks();
  if (books.length > 0) return;

  const book: Book = {
    id: 'seed-lunyu',
    title: '论语（节选）',
    author: '孔门弟子 辑录',
    format: 'builtin',
    coverTone: 3,
    createdAt: Date.now(),
    progress: { chapterId: 'seed-c1', ratio: 0 },
    chapters: [
      {
        id: 'seed-c1',
        title: '学而第一',
        paragraphs: [
          '子曰：“学而时习之，不亦说乎？有朋自远方来，不亦乐乎？人不知而不愠，不亦君子乎？”',
          '有子曰：“其为人也孝弟，而好犯上者，鲜矣；不好犯上，而好作乱者，未之有也。君子务本，本立而道生。孝弟也者，其为仁之本与！”',
          '子曰：“巧言令色，鲜矣仁！”',
          '曾子曰：“吾日三省吾身：为人谋而不忠乎？与朋友交而不信乎？传不习乎？”',
          '子曰：“君子食无求饱，居无求安，敏于事而慎于言，就有道而正焉，可谓好学也已。”',
        ],
      },
      {
        id: 'seed-c2',
        title: '为政第二',
        paragraphs: [
          '子曰：“为政以德，譬如北辰，居其所而众星共之。”',
          '子曰：“吾十有五而志于学，三十而立，四十而不惑，五十而知天命，六十而耳顺，七十而从心所欲，不逾矩。”',
          '子曰：“温故而知新，可以为师矣。”',
          '子曰：“学而不思则罔，思而不学则殆。”',
          '子曰：“由，诲女知之乎！知之为知之，不知为不知，是知也。”',
        ],
      },
      {
        id: 'seed-c3',
        title: '里仁第四',
        paragraphs: [
          '子曰：“里仁为美。择不处仁，焉得知？”',
          '子曰：“不仁者不可以久处约，不可以长处乐。仁者安仁，知者利仁。”',
          '子曰：“朝闻道，夕死可矣。”',
          '子曰：“君子喻于义，小人喻于利。”',
          '子曰：“见贤思齐焉，见不贤而内自省也。”',
        ],
      },
    ],
  };

  const now = Date.now();
  const notes: Note[] = [
    {
      id: 'seed-n1',
      title: '为学之道',
      createdAt: now - 2000,
      updatedAt: now - 1000,
      content: [
        '# 为学之道',
        '',
        '读 [[论语（节选）]] 时最触动我的，是“学而不思则罔，思而不学则殆”这一句。',
        '',
        '- 学是输入，思是消化',
        '- 只输入不消化，如 [[读书方法]] 里说的“藏书不读，与无书同”',
        '',
        '> 温故而知新，可以为师矣。',
        '',
        '回头重读旧笔记，往往比读新书收获更大。',
      ].join('\n'),
    },
    {
      id: 'seed-n2',
      title: '读书方法',
      createdAt: now - 1500,
      updatedAt: now - 500,
      content: [
        '# 读书方法',
        '',
        '1. 先读目录与序言，建立全书地图',
        '2. 第一遍快读，划线不摘抄',
        '3. 第二遍慢读，把书摘整理成笔记，并用 [[ ]] 串起来',
        '',
        '相关：[[为学之道]]、[[论语（节选）]]',
      ].join('\n'),
    },
  ];

  const seedText = '子曰：“学而不思则罔，思而不学则殆。”';
  const highlight: Highlight = {
    id: 'seed-h1',
    bookId: book.id,
    chapterId: 'seed-c2',
    chapterTitle: '为政第二',
    text: seedText,
    paraIndex: 3,
    start: 0,
    end: seedText.length,
    style: { kind: 'underline', color: 'orange' },
    note: '学与思是输入与消化的关系，二者缺一不可。',
    noteId: 'seed-n1',
    createdAt: now,
  };

  await putBook(book);
  for (const n of notes) await putNote(n);
  await putHighlight(highlight);
}
