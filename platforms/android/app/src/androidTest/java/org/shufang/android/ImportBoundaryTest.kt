package org.shufang.android

import android.app.Application
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

class ImportBoundaryTest {
    @Test fun fileProviderImportEnforcesWebLimitsAndCancelCreatesNoBusinessRecord():Unit=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val model=LibraryViewModel(context.applicationContext as Application)
        val store=ViewModelStore().apply {put("import-test",model)}
        withTimeout(30_000){while(!model.state.value.ready)delay(100)}
        val before=model.repository.list("books").map {it.id}.toSet()
        val directory=File(context.cacheDir,"shares/limit-${UUID.randomUUID()}").apply {mkdirs()}
        val oversized=File(directory,"oversized.txt");RandomAccessFile(oversized,"rw").use {it.setLength(65L*1024*1024)}
        val small=File(directory,"cancellable.txt").apply {writeText("离线导入取消测试 🚀")}
        fun uri(file:File)=FileProvider.getUriForFile(context,"${context.packageName}.files",file)
        try {
            model.import(uri(oversized),"reflow").join()
            assertTrue(model.state.value.error,model.state.value.error.contains("格式上限"))
            model.import(uri(small),"reflow").join()
            assertNotNull(model.state.value.importFile)
            model.cancelImport();assertNull(model.state.value.importFile)
            assertEquals(before,model.repository.list("books").map {it.id}.toSet())
        }finally {store.clear();oversized.delete();small.delete();directory.delete()}
    }
}
