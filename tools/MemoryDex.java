import java.io.*;
import java.net.URI;
import java.nio.file.*;
import java.util.*;
import javax.tools.*;
import com.android.tools.r8.*;

/** Build the small APK wrapper without temporary class or dex files. */
class MemoryDex {
  public static void main(String[] args) throws Exception {
    JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();
    StandardJavaFileManager standard=compiler.getStandardFileManager(null,null,null);
    Map<String,ByteArrayOutputStream> classes=new LinkedHashMap<>();
    JavaFileManager memory=new ForwardingJavaFileManager<StandardJavaFileManager>(standard){
      @Override public JavaFileObject getJavaFileForOutput(Location location,String name,JavaFileObject.Kind kind,FileObject sibling){
        ByteArrayOutputStream out=new ByteArrayOutputStream();classes.put(name,out);
        return new SimpleJavaFileObject(URI.create("memory:///"+name.replace('.','/')+kind.extension),kind){
          @Override public OutputStream openOutputStream(){return out;}
        };
      }
    };
    if(!compiler.getTask(new PrintWriter(System.err),memory,null,
      Arrays.asList("-encoding","UTF-8","-source","8","-target","8","-classpath",args[0]),
      null,standard.getJavaFileObjects(args[1],args[2])).call())throw new IOException("Java compilation failed");
    DexIndexedConsumer consumer=new DexIndexedConsumer(){
      public void accept(int index,ByteDataView data,Set<String> descriptors,DiagnosticsHandler handler){
        if(index!=0)throw new IllegalStateException("Unexpected multidex wrapper");
        try{System.out.write(data.copyByteData());}catch(IOException error){throw new RuntimeException(error);}
      }
      public void finished(DiagnosticsHandler handler){}
    };
    D8Command.Builder builder=D8Command.builder().addLibraryFiles(Paths.get(args[0])).setMinApiLevel(24).setProgramConsumer(consumer);
    for(Map.Entry<String,ByteArrayOutputStream> entry:classes.entrySet()){
      if(entry.getKey().contains("NextActivity"))builder.addClassProgramData(entry.getValue().toByteArray(),com.android.tools.r8.origin.Origin.unknown());
      else {
        final String descriptor="L"+entry.getKey().replace('.','/')+";";
        final byte[] bytes=entry.getValue().toByteArray();
        builder.addClasspathResourceProvider(new ClassFileResourceProvider(){
          public Set<String> getClassDescriptors(){return Collections.singleton(descriptor);}
          public ProgramResource getProgramResource(String name){return descriptor.equals(name)?ProgramResource.fromBytes(com.android.tools.r8.origin.Origin.unknown(),ProgramResource.Kind.CF,bytes,Collections.singleton(descriptor)):null;}
        });
      }
    }
    D8.run(builder.build());System.out.flush();standard.close();
  }
}
