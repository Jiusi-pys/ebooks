package org.shufang.android

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID

class FeatureFlowTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun nativeLibraryCitationMindMapStudySetAndReviewRoundTrip():Unit=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        check(context.getSharedPreferences("android-ui",0).getString("origin",null).isNullOrBlank()){ "UI write tests require an isolated offline library" }
        val repository=CoreRepository(context);repository.open()
        val suffix=UUID.randomUUID().toString().take(8)
        val title="功能验收 $suffix";val noteTitle="引用笔记 $suffix";val mapTitle="测试脑图 $suffix";val setTitle="测试学习集 $suffix"
        val source=File(context.cacheDir,"flow-$suffix.txt").apply {writeText("Android 功能验证 🚀")}
        val parsed=File(context.cacheDir,"flow-$suffix.json").apply {writeText(JSONObject().put("title",title).put("author","测试作者").put("format","txt").put("coverTone",0).put("chapters",JSONArray().put(JSONObject().put("id","chapter-$suffix").put("title","第一章").put("paragraphs",JSONArray().put("Android 功能验证 🚀")))).put("progress",JSONObject().put("chapterId","chapter-$suffix").put("ratio",0)).toString())}
        val book=Record.from(repository.command("importParsed",JSONObject().put("path",source.path).put("parsedPath",parsed.path)))
        val note=repository.save("notes",null,JSONObject().put("title",noteTitle).put("content","## 原生笔记\n- [ ] 复习引用"))
        val quote=repository.save("highlights",null,JSONObject().put("bookId",book.id).put("chapterId","chapter-$suffix").put("chapterTitle","第一章").put("paraIndex",0).put("start",0).put("end",7).put("text","Android").put("note","功能批注").put("tags",JSONArray().put("验收")).put("cloze",JSONArray().put("Android")))
        repository.command("cite",JSONObject().put("highlight",quote.id).put("note",note.id).put("highlightRevision",quote.revision).put("noteRevision",note.revision))
        val cited=repository.get("highlights",quote.id)
        repository.command("setReview",JSONObject().put("id",cited.id).put("expected",cited.revision).put("enabled",true))
        val map=repository.save("mindMaps",null,JSONObject().put("title",mapTitle).put("bookId",book.id).put("root",JSONObject().put("id","root-$suffix").put("text","主题").put("children",JSONArray().put(JSONObject().put("id","node-$suffix").put("text","节点 A").put("sourceHighlightId",quote.id).put("children",JSONArray())))))
        val set=repository.save("studySets",null,JSONObject().put("name",setTitle).put("description","本地功能链路验收").put("bookIds",JSONArray().put(book.id)))
        val graph=knowledgeGraph(mapOf("books" to listOf(book),"notes" to listOf(note),"highlights" to listOf(repository.get("highlights",quote.id)),"mindMaps" to listOf(map)))
        assertEquals(4,graph.nodes.size);assertTrue(graph.edges.contains("highlights:${quote.id}" to "mindMaps:${map.id}"));assertTrue(graph.edges.contains("highlights:${quote.id}" to "notes:${note.id}"))
        context.getSharedPreferences("android-ui",0).edit().putString("route:local","books").commit()
        val scenario=ActivityScenario.launch(MainActivity::class.java)
        fun click(text:String)=compose.onNode(hasText(text) and hasClickAction()).performClick()
        fun more(text:String){compose.onNodeWithContentDescription("更多功能").performClick();compose.waitUntil(10_000){compose.onAllNodesWithTag("more-menu").fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithTag("more-menu").performScrollToNode(hasText(text));click(text)}
        fun waitText(text:String){compose.waitUntil(20_000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
        fun filter(text:String){compose.waitUntil(20_000){compose.onAllNodes(hasText("搜索当前列表") and hasSetTextAction()).fetchSemanticsNodes().isNotEmpty()};compose.onNode(hasText("搜索当前列表") and hasSetTextAction()).apply {performTextReplacement(text);performImeAction()}}
        try {
            waitText("本地书库 · 离线可用");filter(title)
            compose.onNode(hasText(title) and hasClickAction() and !hasSetTextAction()).performClick()
            compose.onNodeWithContentDescription("返回书架").assertExists()
            scenario.recreate();compose.onNodeWithContentDescription("返回书架").assertExists()
            compose.onNodeWithContentDescription("返回书架").performClick()
            click("笔记");filter(noteTitle)
            compose.onNode(hasText(noteTitle) and hasClickAction() and !hasSetTextAction()).performClick()
            compose.onNodeWithText("跳转引用：Android").performScrollTo().performClick()
            compose.waitUntil(20_000){compose.onAllNodesWithContentDescription("返回书架").fetchSemanticsNodes().isNotEmpty()}
            compose.onNodeWithContentDescription("返回书架").performClick()
            more("脑图");filter(mapTitle)
            compose.onNode(hasText(mapTitle) and hasClickAction() and !hasSetTextAction()).performClick()
            compose.onNode(hasText("节点内容") and hasSetTextAction()).performScrollTo().performTextReplacement("修改后的节点")
            compose.onNode(hasText("保存") and hasClickAction()).performScrollTo().performClick()
            compose.waitUntil(15_000){compose.onAllNodesWithText("编辑脑图").fetchSemanticsNodes().isEmpty()}
            assertEquals("修改后的节点",repository.get("mindMaps",map.id).value.getJSONObject("root").getJSONArray("children").getJSONObject(0).getString("text"))
            more("学习集");filter(setTitle)
            compose.onNode(hasText(setTitle) and hasClickAction() and !hasSetTextAction()).performClick()
            waitText("1 本书 · 1 张卡片 · 1 幅脑图 · 1 张到期")
            click("复习本集");waitText("待复习 1 张");click("显示答案");click("良好");waitText("待复习 0 张")
            assertTrue(repository.get("highlights",quote.id).value.getJSONObject("review").getLong("due")>System.currentTimeMillis())
            val events=repository.list("reviews").filter {it.text("highlightId")==quote.id}
            assertEquals(1,events.size)
            assertEquals(3,events.single().value.getJSONObject("state").getInt("lastRating"))
            compose.onNodeWithText("复习历史").performScrollTo().assertIsDisplayed()
            more("图谱");waitText("双指缩放、拖动平移，点击节点或列表打开内容");click("放大");click("复位视图")
        } finally {
            scenario.close()
            for((kind,id) in listOf("studySets" to set.id,"mindMaps" to map.id,"notes" to note.id,"books" to book.id))runCatching {repository.remove(kind,repository.get(kind,id))}
            source.delete();parsed.delete();repository.close()
        }
    }
}
