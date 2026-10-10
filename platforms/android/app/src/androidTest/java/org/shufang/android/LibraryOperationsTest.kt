package org.shufang.android

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class LibraryOperationsTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun touchFolderCreationBatchMoveMetadataAndDeletion():Unit=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        check(context.getSharedPreferences("android-ui",0).getString("origin",null).isNullOrBlank()){ "UI write tests require an isolated offline library" }
        val repository=CoreRepository(context);repository.open()
        val suffix=UUID.randomUUID().toString().take(8);val prefix="Batch-$suffix";val folderName="Folder-$suffix"
        val books=(1..2).map {n->repository.save("books",null,JSONObject().put("title","$prefix-$n").put("author","Author").put("format","txt").put("chapters",JSONArray().put(JSONObject().put("id","c$n").put("title","Chapter").put("paragraphs",JSONArray().put("Body $n")))))}
        context.getSharedPreferences("android-ui",0).edit().putString("route:local","books").commit()
        val scenario=ActivityScenario.launch(MainActivity::class.java)
        fun waitFor(matcher:SemanticsMatcher){compose.waitUntil(20_000){compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()}}
        fun click(text:String){compose.onNode(hasText(text) and hasClickAction()).performClick()}
        fun more(text:String){compose.waitUntil(10_000){var focused=false;scenario.onActivity {focused=it.hasWindowFocus()};focused};compose.onNodeWithContentDescription("更多功能").assertIsDisplayed().performClick();waitFor(hasTestTag("more-menu"));compose.onNodeWithTag("more-menu").performScrollToNode(hasText(text));compose.onNode(hasText(text) and hasClickAction() and !SemanticsMatcher.expectValue(SemanticsProperties.Role,Role.Tab)).performClick()}
        fun filter(text:String){compose.onNode(hasText("搜索当前列表") and hasSetTextAction()).apply {performTextReplacement(text);performImeAction()}}
        fun openMenu(title:String){waitFor(hasTestTag("library-grid"));val index=runBlocking {repository.list("books").filter {it.text("title").contains(prefix)}.indexOfFirst {it.text("title")==title}};check(index>=0);compose.onNodeWithTag("library-grid").performScrollToIndex(index);compose.onNodeWithTag("library-grid").performScrollToNode(hasContentDescription("$title 操作"));compose.onNodeWithContentDescription("$title 操作").performScrollTo().assertIsDisplayed().performClick();waitFor(hasTestTag("record-menu"))}
        fun select(title:String){openMenu(title);compose.onNodeWithText("选择 / 批量操作").performScrollTo().performClick()}
        var folder:Record?=null
        try {
            waitFor(hasText("本地书库 · 离线可用"));more("文件夹")
            compose.onNodeWithContentDescription("新建").performClick()
            compose.onNode(hasText("名称") and hasSetTextAction()).performTextInput(folderName)
            click("学习");compose.onNode(hasText("保存") and hasClickAction()).performScrollTo().performClick()
            compose.waitUntil(20_000){compose.onAllNodesWithText("新建文件夹").fetchSemanticsNodes().isEmpty()}
            folder=repository.list("folders").single {it.text("name")==folderName}
            assertEquals("study",folder!!.text("icon"))
            more("书架");filter(prefix);select(books[0].text("title"));select(books[1].text("title"));click("移动")
            compose.onNode(hasText(folderName) and SemanticsMatcher.expectValue(SemanticsProperties.Role,Role.Button)).performClick()
            compose.waitUntil(20_000){compose.onAllNodesWithText("移动所选书籍").fetchSemanticsNodes().isEmpty()}
            assertTrue(books.all {repository.get("books",it.id).text("folderId")==folder!!.id})
            compose.onNode(hasText(folderName) and SemanticsMatcher.expectValue(SemanticsProperties.Role,Role.Checkbox)).performClick()
            openMenu(books[0].text("title"));compose.onNodeWithText("编辑").performScrollTo().performClick()
            compose.onNode(hasText("作者") and hasSetTextAction()).performTextReplacement("触摸修改作者 🚀")
            compose.onNode(hasText("保存") and hasClickAction()).performScrollTo().performClick()
            compose.waitUntil(20_000){compose.onAllNodesWithText("编辑书架").fetchSemanticsNodes().isEmpty()}
            assertEquals("触摸修改作者 🚀",repository.get("books",books[0].id).text("author"))
            select(books[0].text("title"));select(books[1].text("title"));click("移动");click("移出文件夹")
            compose.waitUntil(20_000){compose.onAllNodesWithText("移动所选书籍").fetchSemanticsNodes().isEmpty()}
            assertTrue(books.all {repository.get("books",it.id).text("folderId").isBlank()})
            click("全部书籍");select(books[0].text("title"));select(books[1].text("title"));click("批量删除");click("删除")
            compose.waitUntil(20_000){compose.onAllNodesWithText("没有匹配结果").fetchSemanticsNodes().isNotEmpty()}
            assertTrue(repository.list("books").none {it.id in books.map {b->b.id}})
        }finally {
            scenario.close()
            for(book in books)runCatching {repository.remove("books",repository.get("books",book.id))}
            folder?.let {runCatching {repository.remove("folders",repository.get("folders",it.id))}}
            repository.close()
        }
    }
}
