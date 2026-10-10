package org.shufang.android

import android.content.Intent
import android.view.View
import android.view.ViewGroup
import androidx.core.content.FileProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ImportTouchTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun systemShareImportsAndTouchSelectionSearchAndFormattingWork():Unit=runBlocking {
        val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
        check(context.getSharedPreferences("android-ui",0).getString("origin",null).isNullOrBlank()){ "UI write tests require an isolated offline library" }
        val suffix=UUID.randomUUID().toString().take(8);val title="Touch-$suffix";val needle="passage-$suffix"
        val source=File(context.cacheDir,"shares/$title.txt").apply {parentFile!!.mkdirs();writeText("第一章\n\n正文 $needle 🚀\n\n另一段文字用于翻页与阅读位置。")}
        val uri=FileProvider.getUriForFile(context,"${context.packageName}.files",source)
        val intent=Intent(context,MainActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.getSharedPreferences("android-ui",0).edit().putString("route:local","books").commit()
        val scenario=ActivityScenario.launch<MainActivity>(intent)
        val repository=CoreRepository(context);repository.open()
        fun waitFor(matcher:SemanticsMatcher){compose.waitUntil(30_000){compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()}}
        fun click(text:String){compose.onNode(hasText(text) and hasClickAction()).performClick()}
        fun find(view:View):DocumentWebView?=if(view is DocumentWebView)view else if(view is ViewGroup)(0 until view.childCount).firstNotNullOfOrNull {find(view.getChildAt(it))}else null
        fun js(script:String):String {
            val done=CountDownLatch(1);var result=""
            scenario.onActivity {activity->find(activity.window.decorView)?.evaluateJavascript(script){result=it;done.countDown()}}
            assertTrue("Reader JavaScript callback timed out",done.await(10,TimeUnit.SECONDS));return result
        }
        var id:String?=null
        try {
            val card=hasText(title) and hasClickAction() and !hasSetTextAction()
            compose.waitUntil(30_000){runBlocking {repository.list("books").any {it.text("title")==title}}}
            id=repository.list("books").single {it.text("title")==title}.id
            waitFor(hasText("搜索当前列表") and hasSetTextAction())
            compose.onNode(hasText("搜索当前列表") and hasSetTextAction()).apply {performTextReplacement(title);performImeAction()}
            waitFor(hasTestTag("library-grid"));compose.onNodeWithTag("library-grid").performScrollToNode(card);waitFor(card)
            compose.onNode(card).performClick();waitFor(hasContentDescription("返回书架"))
            compose.waitUntil(20_000){js("[...document.querySelectorAll('p[data-index]')].map(p=>p.textContent).join('\\n')").contains(needle)}
            js("(()=>{const p=[...document.querySelectorAll('p[data-index]')].find(p=>p.textContent.includes('🚀'));const at=p.textContent.indexOf('🚀');const r=document.createRange();r.setStart(p.firstChild,at);r.setEnd(p.firstChild,at+2);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));return true;})()")
            waitFor(hasText("选文操作：🚀"));click("选文操作：🚀")
            compose.onNode(hasText("批注") and hasSetTextAction()).performTextInput("触摸批注 $suffix")
            click("蓝");click("下划线");click("保存书摘")
            compose.waitUntil(20_000){compose.onAllNodes(hasText("批注") and hasSetTextAction()).fetchSemanticsNodes().isEmpty()}
            val quote=repository.list("highlights").single {it.text("bookId")==id}
            assertEquals("🚀",quote.text("text"));assertEquals("触摸批注 $suffix",quote.text("note"));assertEquals("blue",quote.value.getJSONObject("style").getString("color"));assertEquals("underline",quote.value.getJSONObject("style").getString("kind"))
            click("排版")
            compose.onNode(hasText("夜览") and hasClickAction()).performScrollTo().performClick()
            compose.onNode(hasText("保存本书排版") and hasClickAction()).performScrollTo().performClick()
            compose.waitUntil(20_000){compose.onAllNodesWithText("保存本书排版").fetchSemanticsNodes().isEmpty()}
            assertEquals("night",repository.get("books",id!!).value.getJSONObject("typeSettings").getString("themeId"))
            compose.onNodeWithContentDescription("全局搜索").performClick()
            compose.onNode(hasText("搜索全书正文、笔记、书摘与标签") and hasSetTextAction()).performTextInput(needle)
            waitFor(hasText("1 项匹配结果"));compose.onNode(hasText(title) and hasClickAction()).performClick();waitFor(hasContentDescription("返回书架"))
            compose.onNode(hasText("AI") and hasClickAction()).performScrollTo().performClick();waitFor(hasText("配置 AI"));click("返回阅读");waitFor(hasContentDescription("返回书架"))
            source.delete();scenario.recreate();waitFor(hasContentDescription("返回书架"))
            compose.waitUntil(20_000){js("document.body.innerText").contains(needle)}
            assertEquals(1,repository.list("books").count {it.text("title")==title})
        }finally {
            scenario.close()
            id?.let {runCatching {repository.remove("books",repository.get("books",it))}}
            repository.close();source.delete()
        }
    }
}
