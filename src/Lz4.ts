/** Encodes a valid LZ4 block using literals only. This favors portability over compression ratio. */
export const encodeBlock = (input:Uint8Array):Uint8Array => {
  const extension:number[]=[];let remaining=input.length-15
  while(remaining>=255){extension.push(255);remaining-=255}if(input.length>=15)extension.push(remaining)
  const output=new Uint8Array(1+extension.length+input.length);output[0]=Math.min(input.length,15)<<4;output.set(extension,1);output.set(input,1+extension.length);return output
}

/** Dependency-free LZ4 block decoder with overlap-safe match copying. */
export const decodeBlock = (input:Uint8Array, outputSize:number):Uint8Array => {
  const output=new Uint8Array(outputSize);let source=0,target=0
  const length=(base:number):number=>{let value=base;if(base===15){let byte=255;while(byte===255){if(source>=input.length)throw new Error("truncated LZ4 length");byte=input[source++]!;value+=byte}}return value}
  while(source<input.length){const token=input[source++]!,literalLength=length(token>>>4);if(source+literalLength>input.length||target+literalLength>output.length)throw new Error("invalid LZ4 literal length");output.set(input.subarray(source,source+literalLength),target);source+=literalLength;target+=literalLength
    if(source===input.length)break;if(source+2>input.length)throw new Error("truncated LZ4 match offset");const offset=input[source]!|(input[source+1]!<<8);source+=2;if(offset===0||offset>target)throw new Error("invalid LZ4 match offset");const matchLength=length(token&15)+4;if(target+matchLength>output.length)throw new Error("invalid LZ4 match length");for(let index=0;index<matchLength;index++)output[target+index]=output[target-offset+index]!;target+=matchLength
  }
  if(target!==output.length)throw new Error(`invalid LZ4 output size: ${target}, expected ${output.length}`);return output
}
