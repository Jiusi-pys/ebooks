package org.shufang.android

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class MindMoveTouchTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun movingByTouchPersistsSubtreeAndItsSharedCard():Unit=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName=="org.shufang.android.acceptance")
        check(context.getSharedPreferences("android-ui",0).getString("origin",null).isNullOrBlank())
        val repository=CoreRepository(context);repository.open()
        val suffix=UUID.randomUUID().toString().take(8)
        fun node(id:String,text:String,vararg children:JSONObject)=JSONObject().put("id",id).put("text",text).put("children",JSONArray(children.toList()))
        val title="Move-$suffix"
        val book=repository.save("books",null,JSONObject().put("title",title).put("author","").put("format","txt").put("chapters",JSONArray().put(JSONObject().put("id","chapter").put("title","chapter").put("paragraphs",JSONArray().put("正文")))))
        val quote=repository.save("highlights",null,JSONObject().put("kind","text").put("bookId",book.id).put("chapterId","chapter").put("paraIndex",0).put("start",0).put("end",2).put("text","正文"))
        val card=node("card","Card-$suffix").put("sourceHighlightId",quote.id).put("chapterId","chapter")
        val record=repository.save("mindMaps",null,JSONObject().put("title",title).put("bookId",book.id).put("root",node("root","Root-$suffix",node("one","One-$suffix",card),node("two","Two-$suffix"))))
        context.getSharedPreferences("android-ui",0).edit().putString("route:local","mindMaps").commit()
        var scenario=ActivityScenario.launch(MainActivity::class.java)
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        var displayId=0
        scenario.onActivity {displayId=it.windowManager.defaultDisplay.displayId}
        fun shell(command:String)=instrumentation.uiAutomation.executeShellCommand(command).use {android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().readText()}
        val oldSize=shell("wm size -d $displayId");val oldDensity=shell("wm density -d $displayId")
        val width=InstrumentationRegistry.getArguments().getString("windowWidthDp")?.toInt()
        fun applyWindow(){if(width!=null){scenario.onActivity {displayId=it.windowManager.defaultDisplay.displayId;it.requestedOrientation=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT};shell("wm density 160 -d $displayId");shell("wm size ${width}x1280 -d $displayId");compose.waitUntil(10_000){var actual=0;scenario.onActivity {actual=it.resources.configuration.screenWidthDp};actual==width}}}
        fun waitFor(matcher:SemanticsMatcher){compose.waitUntil(20_000){compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()}}
        fun openEditor(){
            waitFor(hasText("搜索当前列表"))
            compose.onNode(hasText("搜索当前列表") and hasSetTextAction()).apply {performTextReplacement(title);performImeAction()}
            waitFor(hasContentDescription("$title 操作"))
            compose.onNodeWithContentDescription("$title 操作").performScrollTo().performClick()
            waitFor(hasText("编辑"));compose.onNodeWithText("编辑").performScrollTo().performClick()
            waitFor(hasText("焦点子树"))
        }
        try {
            applyWindow()
            openEditor()
            compose.onNodeWithText("树形画布").performScrollTo().performClick()
            compose.onNodeWithTag("mind-canvas").performScrollTo()
            compose.onNodeWithTag("mind-canvas-card").performScrollTo().assertIsDisplayed().performClick()
            compose.onNodeWithText("移动到其他节点").performScrollTo().performClick()
            waitFor(hasText("选择新的父节点"))
            compose.onNode(hasText("Two-$suffix") and SemanticsMatcher.expectValue(SemanticsProperties.Role,Role.Button)).performScrollTo().performClick()
            compose.onNode(hasText("保存") and hasClickAction()).performScrollTo().performClick()
            compose.waitUntil(20_000){compose.onAllNodesWithText("编辑脑图").fetchSemanticsNodes().isEmpty()}
            val saved=repository.get("mindMaps",record.id).value.getJSONObject("root")
            assertEquals(0,findMindNode(saved,"one")!!.getJSONArray("children").length())
            assertEquals("card",findMindNode(saved,"two")!!.getJSONArray("children").getJSONObject(0).getString("id"))
            assertEquals(quote.id,findMindNode(saved,"card")!!.getString("sourceHighlightId"))
            scenario.close();scenario=ActivityScenario.launch(MainActivity::class.java)
            applyWindow()
            openEditor()
            compose.onNodeWithText("树形画布").performScrollTo().performClick()
            compose.onNodeWithTag("mind-canvas").performScrollTo()
            compose.onNodeWithTag("mind-canvas-card").performScrollTo().assertIsDisplayed().performClick()
            // The dedicated API 26 SDK emulator has one display. Compose's
            // dialog capture helper requires API 28, so use its actual screen.
            val bitmap=if(android.os.Build.VERSION.SDK_INT<28)requireNotNull(instrumentation.uiAutomation.takeScreenshot())else compose.onNodeWithTag("mind-canvas").captureToImage().asAndroidBitmap()
            context.getExternalFilesDir(null)!!.resolve("mind-move-touch.png").outputStream().use {bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()
            scenario.onActivity {activity->val config=activity.resources.configuration;val metrics=activity.resources.displayMetrics;context.getExternalFilesDir(null)!!.resolve("mind-move-metrics.json").writeText(JSONObject().put("widthDp",config.screenWidthDp).put("heightDp",config.screenHeightDp).put("fontScale",config.fontScale).put("widthPixels",metrics.widthPixels).put("heightPixels",metrics.heightPixels).put("densityDpi",metrics.densityDpi).toString())}
            assertEquals(saved.toString(),repository.get("mindMaps",record.id).value.getJSONObject("root").toString())
        } finally {
            if(width!=null){val size=Regex("Override size: (\\d+x\\d+)").find(oldSize)?.groupValues?.get(1)?:"reset";val density=Regex("Override density: (\\d+)").find(oldDensity)?.groupValues?.get(1)?:"reset";shell("wm size $size -d $displayId");shell("wm density $density -d $displayId")}
            scenario.close()
            runCatching {repository.remove("mindMaps",repository.get("mindMaps",record.id))}
            runCatching {repository.remove("books",repository.get("books",book.id))}
            repository.close()
        }
    }
}
