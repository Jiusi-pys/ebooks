package org.shufang.android

import android.app.ActivityManager
import android.content.Context
import android.net.Uri
import android.os.Build
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import java.io.File
import java.security.MessageDigest

object NativeLlm {
    private val loaded by lazy {runCatching {System.loadLibrary("shufang_llm");true}.getOrDefault(false)}
    fun available()=Build.VERSION.SDK_INT>=28&&loaded
    external fun open(path:ByteArray):Long
    external fun close(handle:Long)
    external fun prompt(handle:Long,text:ByteArray)
    external fun next(handle:Long):ByteArray?
}
class LocalAi(private val context:Context) {
    private val directory=File(context.filesDir,"local-models").apply {mkdirs()}
    private val gate=Mutex()
    val model get()=File(directory,"active.gguf").takeIf {it.exists()}
    fun status():String=when {Build.VERSION.SDK_INT<28->"设备端模型需要 Android 9 或以上";!NativeLlm.available()->"设备端运行库不可用";model==null->"尚未安装离线模型，可从文件导入 GGUF";else->"离线模型已安装 · ${(model!!.length()/1024/1024)} MiB"}
    suspend fun install(uri:Uri)=withContext(Dispatchers.IO){gate.lock();try {val staged=File(directory,"model.pending");try {val hash=MessageDigest.getInstance("SHA-256");context.contentResolver.openInputStream(uri)?.use {input->staged.outputStream().use {output->val buffer=ByteArray(256*1024);var size=0L;while(true){ensureActive();val count=input.read(buffer);if(count<0)break;size+=count;require(size<=2L*1024*1024*1024){"模型超过 2 GiB"};output.write(buffer,0,count);hash.update(buffer,0,count)}}}?:error("无法读取模型");staged.inputStream().use {input->val magic=ByteArray(4);require(input.read(magic)==4&&String(magic,Charsets.US_ASCII)=="GGUF"){"请选择 GGUF 模型"}};require(NativeLlm.available()){status()};checkMemory(staged);val handle=NativeLlm.open(staged.path.toByteArray());NativeLlm.close(handle);val destination=File(directory,"active.gguf");java.nio.file.Files.move(staged.toPath(),destination.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE);File(directory,"active.sha256").writeText(hash.digest().joinToString(""){"%02x".format(it)})}finally {staged.delete()}}finally {gate.unlock()}}
    suspend fun remove()=withContext(Dispatchers.IO){gate.lock();try {model?.delete();File(directory,"active.sha256").delete()}finally {gate.unlock()}}
    private fun checkMemory(file:File) {
        val memory=ActivityManager.MemoryInfo()
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memory)
        require(!memory.lowMemory && memory.availMem>file.length()*2+256L*1024*1024) { "当前内存不足，先关闭其他应用或选择更小模型" }
    }
    private suspend fun verifyModel(file:File) {
        val expected=File(directory,"active.sha256").takeIf {it.isFile}?.readText()?.trim() ?: error("模型校验信息缺失，请重新导入")
        val digest=MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer=ByteArray(256*1024); while(true) {currentCoroutineContext().ensureActive();val count=input.read(buffer);if(count<0)break;digest.update(buffer,0,count)} }
        require(digest.digest().joinToString(""){"%02x".format(it)}==expected) {"离线模型校验失败，请重新导入"}
    }
    fun answer(prompt:String):Flow<String> = flow {
        gate.lock();var handle=0L
        try {val file=model?:error(status());require(NativeLlm.available()){status()};val memory=ActivityManager.MemoryInfo();(context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memory);require(!memory.lowMemory&&memory.availMem>file.length()*2+256L*1024*1024){"当前内存不足，先关闭其他应用或选择更小模型"};verifyModel(file);handle=NativeLlm.open(file.path.toByteArray());currentCoroutineContext().ensureActive();NativeLlm.prompt(handle,prompt.toByteArray());val result=java.io.ByteArrayOutputStream();while(true){currentCoroutineContext().ensureActive();val token=NativeLlm.next(handle)?:break;result.write(token);emit(result.toString(Charsets.UTF_8.name()))}}
        finally {if(handle!=0L)NativeLlm.close(handle);gate.unlock()}
    }.flowOn(Dispatchers.IO)
}
