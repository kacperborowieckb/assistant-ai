import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

interface Props {
  questions: readonly { q: string; a: string }[];
}

// Questions open one at a time, with Radix measuring the height so the
// animation is smooth in every browser.
export const FaqList = ({ questions }: Props) => (
  <Accordion type="single" collapsible className="border-border border-y">
    {questions.map((item) => (
      <AccordionItem key={item.q} value={item.q} className="border-border">
        <AccordionTrigger>{item.q}</AccordionTrigger>
        <AccordionContent>
          <p>{item.a}</p>
        </AccordionContent>
      </AccordionItem>
    ))}
  </Accordion>
);
