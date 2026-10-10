package org.shufang.android

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID

/** Real touch checks and screenshots. Temporary, original sample content is removed afterwards. */
class ReadingDesignTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun coverShelfAndReadingToolsRemainReachable():Unit=runBlocking {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val context=instrumentation.targetContext
        val prefs=context.getSharedPreferences("android-ui",0)
        assertTrue("Use the offline test library",prefs.getString("origin",null).isNullOrBlank())
        val repository=CoreRepository(context);repository.open()
        val books=mutableListOf<Record>();val files=mutableListOf<File>()
        val suffix=UUID.randomUUID().toString()
        for(title in listOf("缓慢阅读","记录与连接","留白之间")) {
            val source=File(context.cacheDir,"design-${UUID.randomUUID()}.txt").apply {writeText("$title\n\n第一章\n\n在一页文字里，给自己留下一点安静。\n\n阅读不必匆忙。记录当下的想法，也允许问题暂时没有答案。\n\n这是用于界面验收的原创样例，测试结束后自动移除。")};files+=source
            val parsed=File(context.cacheDir,"design-${UUID.randomUUID()}.json").apply {writeText(JSONObject().put("title",title).put("author","书房 · 设计样例 $suffix").put("format","txt").put("coverTone",0).put("progress",JSONObject().put("chapterId","chapter-one").put("ratio",0)).put("chapters",JSONArray().put(JSONObject().put("id","chapter-one").put("title","第一章 · 留给自己的时间").put("paragraphs",JSONArray().put("在一页文字里，给自己留下一点安静。").put("阅读不必匆忙。记录当下的想法，也允许问题暂时没有答案。").put("这是用于界面验收的原创样例，测试结束后自动移除。")))).toString())};files+=parsed
            books+=Record.from(repository.command("importParsed",JSONObject().put("path",source.path).put("parsedPath",parsed.path)))
        }
        prefs.edit().putString("route:local","books").commit()
        val scenario=ActivityScenario.launch(MainActivity::class.java)
        val requestedOrientation=if(InstrumentationRegistry.getArguments().getString("orientation")=="landscape") android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        scenario.onActivity {it.requestedOrientation=requestedOrientation}
        var displayID=0
        scenario.onActivity {displayID=it.windowManager.defaultDisplay.displayId}
        fun shell(command:String):String=instrumentation.uiAutomation.executeShellCommand(command).use {android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().readText()}
        val oldSize=shell("wm size -d $displayID")
        val oldDensity=shell("wm density -d $displayID")
        val requestedWidth=InstrumentationRegistry.getArguments().getString("windowWidthDp")?.toInt()
        fun capture(name:String) {
            compose.waitForIdle()
            val copied=java.util.concurrent.CountDownLatch(1);var copyResult=-1;lateinit var bitmap:Bitmap
            scenario.onActivity {activity->bitmap=Bitmap.createBitmap(activity.window.decorView.width,activity.window.decorView.height,Bitmap.Config.ARGB_8888);android.view.PixelCopy.request(activity.window,bitmap,{copyResult=it;copied.countDown()},android.os.Handler(android.os.Looper.getMainLooper()))}
            assertTrue("Window image timed out",copied.await(10,java.util.concurrent.TimeUnit.SECONDS));org.junit.Assert.assertEquals("Window image failed",android.view.PixelCopy.SUCCESS,copyResult)
            File(context.getExternalFilesDir(null),"redesign-$name.png").outputStream().use {bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}
            scenario.onActivity {activity->val configuration=activity.resources.configuration;val metrics=activity.resources.displayMetrics
                File(context.getExternalFilesDir(null),"metrics-$name.json").writeText(JSONObject().put("displayID",displayID).put("widthDp",configuration.screenWidthDp).put("heightDp",configuration.screenHeightDp).put("fontScale",configuration.fontScale).put("widthPixels",metrics.widthPixels).put("heightPixels",metrics.heightPixels).put("densityDpi",metrics.densityDpi).put("orientation",configuration.orientation).toString())
            }
        }
        try {
        if(requestedWidth!=null){shell("wm density 160 -d $displayID");shell("wm size $requestedWidth"+"x1280 -d $displayID");compose.waitUntil(10_000){var width=0;scenario.onActivity {width=it.resources.configuration.screenWidthDp};width==requestedWidth}}
            compose.waitUntil(20_000){compose.onAllNodesWithText("把时间，留给阅读。").fetchSemanticsNodes().isNotEmpty()}
            compose.onNode(hasText("搜索当前列表") and hasSetTextAction()).apply {performTextReplacement("设计样例");performImeAction()}
            compose.waitUntil(20_000){compose.onAllNodesWithTag("library-grid").fetchSemanticsNodes().isNotEmpty()}
            compose.onNodeWithTag("library-grid").performScrollToNode(hasText("缓慢阅读"))
            capture("shelf")
            compose.onNode(hasText("缓慢阅读") and hasClickAction() and !hasSetTextAction()).performClick()
            compose.onNodeWithContentDescription("更多阅读工具").performScrollTo().performClick()
            compose.onNodeWithText("阅读工具").assertIsDisplayed()
            compose.onNode(hasText("引用章节") and hasClickAction()).performScrollTo().assertIsDisplayed()
            compose.onNode(hasText("分享原文件") and hasClickAction()).performScrollTo().assertIsDisplayed()
            instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            compose.onNode(hasText("排版") and hasClickAction()).performScrollTo().assertIsDisplayed()
            var bodyVisible=false
            fun findWeb(view:android.view.View):DocumentWebView? {if(view is DocumentWebView)return view;if(view is android.view.ViewGroup)for(index in 0 until view.childCount){findWeb(view.getChildAt(index))?.let {return it}};return null}
            compose.waitUntil(20_000){scenario.onActivity {activity->findWeb(activity.window.decorView)?.evaluateJavascript("document.fonts.status==='loaded'&&document.querySelector('#content')&&document.querySelector('#content').textContent.includes('给自己留下一点安静')"){bodyVisible=it=="true"}};bodyVisible}
            capture("reader")
            compose.onNodeWithContentDescription("返回书架").performScrollTo().performClick()
            compose.onNode(hasText("笔记") and hasClickAction()).performClick()
            compose.onNode(hasText("搜索当前列表") and hasSetTextAction()).apply {performTextReplacement("");performImeAction()}
            capture("notes")
            compose.onNode(hasText("设置") and hasClickAction()).performClick()
            capture("settings")
            scenario.onActivity {it.requestedOrientation=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE}
            compose.waitForIdle()
            capture("settings-landscape")
        } finally {
            if(requestedWidth!=null){val size=Regex("Override size: (\\d+x\\d+)").find(oldSize)?.groupValues?.get(1)?:"reset";val density=Regex("Override density: (\\d+)").find(oldDensity)?.groupValues?.get(1)?:"reset";shell("wm size $size -d $displayID");shell("wm density $density -d $displayID")}
            scenario.close()
            for(book in books)runCatching {repository.remove("books",repository.get("books",book.id))}
            repository.close();files.forEach {it.delete()}
            prefs.edit().putString("route:local","books").commit()
        }
    }
}
